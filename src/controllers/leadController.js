import { sendLeadToZoho } from "../services/zohoService.js";
import {
  saveLeadToDatabase,
  enqueueCustomerEmail,
} from "../services/supabaseService.js";
import { sendLeadNotificationEmail } from "../services/leadNotificationService.js";
import { calculateQuote } from "../services/cleaningQuoteCalculator.js";
import {
  buildResidentialQuoteEmail,
  buildCommercialInquiryEmail,
} from "../services/clientQuoteEmailService.js";
import { getSuggestedSlots } from "../services/availabilityService.js";
import { sendLeadEmailFailureAlert } from "../services/opsNotificationService.js";
import { verifyRecaptcha } from "../services/recaptchaService.js";

export async function createLead(req, res) {
  try {
    const { recaptchaToken, ...leadData } = req.body;

    if (!recaptchaToken) {
      return res.status(400).json({ error: "Missing reCAPTCHA token" });
    }

    const isHuman = await verifyRecaptcha(recaptchaToken, req.ip, {
      context: "lead",
    });
    if (!isHuman) {
      return res.status(400).json({ error: "Failed reCAPTCHA validation" });
    }

    if (!leadData.email) {
      return res.status(400).json({ error: "Missing required field: email" });
    }

    if (!leadData.fullName && leadData.source === "newsletter") {
      leadData.fullName = "Newsletter Subscriber";
    }

    if (!leadData.fullName) {
      return res
        .status(400)
        .json({ error: "Missing required field: fullName" });
    }

    // Opcional: marca de fuente para distinguir este formulario
    if (!leadData.source) leadData.source = `${BRAND_NAME} Booking Form`;

    // Normalize preferredTime: the form now sends an array; guard against legacy string values.
    if (leadData.preferredTime !== undefined) {
      if (!Array.isArray(leadData.preferredTime)) {
        leadData.preferredTime = leadData.preferredTime
          ? [leadData.preferredTime]
          : [];
      }
    }

    // Cotizacion: se calcula ACA, antes de guardar, para que las horas
    // estimadas queden persistidas en el lead. GET /api/availability?leadId=
    // y POST /api/availability/book leen leads.estimated_hours_per_person para
    // dimensionar la ventana de reserva; si queda en null caen a MIN_HOURS y
    // se agenda menos tiempo del que prometio el email de cotizacion.
    const isCommercial =
      /office|commercial/i.test(leadData.serviceOption || "") ||
      leadData.serviceType === "specialized";

    let quote = null;
    if (!isCommercial) {
      quote = calculateQuote(leadData);
      leadData.estimatedTotalHours = quote.totalHrs;
      leadData.estimatedHoursPerPerson = quote.hrsPerPerson;
      console.log(
        `[QUOTE] ${leadData.email} | ${quote.calcType} | ${quote.totalHrs}h total | ${quote.hrsPerPerson}h por persona | $${quote.totalAmount}`,
      );
    }

    // 4️⃣ Intentar enviar a Zoho primero
    let zohoResult = null;
    let zohoError = null;

    try {
      zohoResult = await sendLeadToZoho(leadData);
      console.log("✅ Lead enviado a Zoho:", zohoResult);
      leadData.zoho_id = zohoResult?.id || null;
    } catch (err) {
      zohoError = err;
      console.warn("⚠️ Falló Zoho, guardando en BD igualmente:", err.message);
    }

    // 6️⃣ Guardar en Supabase con horas estimadas ya incluidas
    let dbLead = null;
    let dbError = null;

    try {
      dbLead = await saveLeadToDatabase(leadData);
    } catch (err) {
      dbError = err;
      console.error("❌ Error guardando lead en BD:", err.message);
    }

    // 7️⃣ Enviar SIEMPRE el mail con el resumen (Zoho + BD + lead)
    try {
      await sendLeadNotificationEmail(leadData, {
        operation: dbLead?._wasUpdate ? "updated" : "created",
        zohoResult,
        zohoError,
        dbLead,
        dbError,
        source: leadData.source || "Website Form",
      });
    } catch (notifyErr) {
      console.error(
        "❌ Error enviando email de notificación de lead:",
        notifyErr.message,
      );
    }

    // 8️⃣ ENCOLAR EMAIL AL CLIENTE SOLO SI SE GUARDÓ EN BD
    try {
      // Solo encolar si la base de datos guardó exitosamente el lead
      if (dbLead?.id) {
        const delayMinutes = 1;
        const dueAt = new Date(
          Date.now() + delayMinutes * 60 * 1000,
        ).toISOString();

        let payload;

        if (isCommercial) {
          const { subject, html } = buildCommercialInquiryEmail({
            lead: leadData,
          });
          payload = {
            to: leadData.email,
            subject,
            html,
            type: "commercial_confirmation",
            leadData: leadData, // Snapshot del lead
          };
        } else {
          // Reutilizar el quote calculado arriba — el mismo que se persistio
          // en el lead — para que el email y la disponibilidad no diverjan.
          const calc = quote;

          // 2️⃣ Pedir slots con la duración correcta para este cliente
          let slots = [];
          try {
            slots = await getSuggestedSlots({
              count: 3,
              minHours: calc.hrsPerPerson,
            });
            console.log(
              `✅ ${slots.length} slots obtenidos para el email (minHours=${calc.hrsPerPerson})`,
            );
          } catch (slotsError) {
            console.warn(
              "⚠️ No se pudieron obtener slots disponibles:",
              slotsError.message,
            );
            slots = [];
          }

          // 3️⃣ leadId en la URL permite que /available filtre ventanas por duración correcta
          const { subject, html } = buildResidentialQuoteEmail({
            lead: leadData,
            calc,
            slots, // can be empty — the email handles both cases
            leadId: dbLead.id, // 👈 so the booking URL includes ?leadId= for pre-fill
          });

          payload = {
            to: leadData.email,
            subject,
            html,
            type: "residential_quote",
            calc,
            leadData: leadData,
            slots,
          };
        }

        await enqueueCustomerEmail({
          leadId: dbLead.id,
          dueAt,
          payload,
        });

        console.log(
          `📨 Email al cliente encolado para enviar en ~${delayMinutes} min (${dueAt})`,
        );
      } else {
        console.warn(
          "⚠️ No se encoló email al cliente porque no se guardó en BD correctamente",
        );
      }
    } catch (clientQueueErr) {
      console.error(
        "❌ Error encolando email al cliente:",
        clientQueueErr.message,
      );
      // No rompas el flujo por esto: el lead ya se guardó y el interno se mandó.
      await sendLeadEmailFailureAlert({ lead: leadData, error: clientQueueErr });
    }

    // 9️⃣ Respuesta HTTP
    if (dbError) {
      // Si la BD falló, devolvés 500 pero ya no encolamos email al cliente
      return res.status(500).json({
        error: "Could not save lead in database",
        details:
          process.env.NODE_ENV === "development" ? dbError.message : undefined,
      });
    }

    let status = "pending";
    if (leadData.source === "newsletter") {
      status = "newsletter";
    } else if (zohoResult) {
      status = "synced";
    }

    return res.status(dbLead?._wasUpdate ? 200 : 201).json({
      message: dbLead?._wasUpdate
        ? "Lead updated successfully"
        : "Lead processed successfully",
      zohoId: zohoResult?.id || null,
      dbId: dbLead.id,
      status,
    });
  } catch (error) {
    console.error("❌ Error processing lead:", error.message);
    return res.status(500).json({
      error: "Could not process lead",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
