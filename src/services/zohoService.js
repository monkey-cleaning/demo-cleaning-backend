import "dotenv/config";
import axios from "axios";

// ── Token cache ───────────────────────────────────────────────────────────────

let accessToken = "";
let accessTokenExpiresAt = 0;

const ZOHO_TOKEN_URL = "https://accounts.zohocloud.ca/oauth/v2/token";
const ZOHO_API_DOMAIN =
  process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.ca";

async function refreshAccessToken() {
  if (!process.env.ZOHO_REFRESH_TOKEN) {
    throw new Error("ZOHO_REFRESH_TOKEN no está definido en .env");
  }
  if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) {
    throw new Error(
      "ZOHO_CLIENT_ID o ZOHO_CLIENT_SECRET no están definidos en .env",
    );
  }

  const response = await axios.post(ZOHO_TOKEN_URL, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token",
    },
  });

  accessToken = response.data.access_token;
  const expiresIn = response.data.expires_in ?? 3600;
  accessTokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;

  console.log(
    "🔑 Nuevo access_token Zoho obtenido. Expira en",
    expiresIn,
    "segundos",
  );
  return accessToken;
}

async function getAccessToken() {
  if (!accessToken || Date.now() >= accessTokenExpiresAt) {
    return refreshAccessToken();
  }
  return accessToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normaliza un día completo al abreviado de 3 letras que Zoho espera
 * en el campo multi-select Day_Preference.
 * "Monday" → "Mon", "wednesday" → "Wed"
 */
function normDay(day = "") {
  const map = {
    monday: "Mon",
    tuesday: "Tue",
    wednesday: "Wed",
    thursday: "Thu",
    friday: "Fri",
    saturday: "Sat",
    sunday: "Sun",
  };
  return map[day.toLowerCase()] ?? day;
}

/**
 * Construye el payload Zoho para un cliente del dashboard.
 * Solo incluye campos con valor para no pisar datos existentes en Zoho.
 *
 * Campos custom requeridos en Zoho CRM (Contacts):
 *   Day_Preference       — Multi-select picklist  (Mon, Tue, Wed…)
 *   Time_Preference      — Single-line text
 *   Availability_Windows — Multi-line text
 *   Type_of_Service      — Single-line text
 *   Rate                 — Number/Currency
 *   Recurring_Service    — Checkbox
 */
function buildContactPayload(client) {
  const parts = [client.first_name, client.last_name].filter(Boolean);
  const firstName = parts[0] ?? "";
  const lastName = parts[1] ?? parts[0] ?? "Unknown";

  const row = { First_Name: firstName, Last_Name: lastName };

  if (client.email) row.Email = client.email;
  if (client.phone) row.Phone = client.phone;
  if (client.mobile) row.Mobile = client.mobile;

  // Dirección
  if (client.default_address) row.Mailing_Street = client.default_address;
  if (client.city) row.Mailing_City = client.city;
  if (client.state) row.Mailing_State = client.state;
  if (client.zip_code) row.Mailing_Zip = client.zip_code;
  if (client.country) row.Mailing_Country = client.country;

  // Servicio
  if (client.service_type) row.Type_of_Service = client.service_type;
  if (client.rate != null) row.Rate = client.rate;
  if (client.is_recurring != null)
    row.Recurring_Service = Boolean(client.is_recurring);
  if (client.notes) row.Description = client.notes;

  // ── Preferencias de días / horario ────────────────────────────────────────

  // preferred_days: ["Monday","Wednesday"] → "Mon;Wed"
  // Zoho multi-select espera valores separados por punto y coma (API v2).
  if (
    Array.isArray(client.preferred_days) &&
    client.preferred_days.length > 0
  ) {
    row.Day_Preference = client.preferred_days.map(normDay).join(";");
  }

  // preferred_time: texto del select, e.g. "Morning (8am–12pm)"
  if (client.preferred_time) {
    row.Time_Preference = client.preferred_time;
  }

  // availability_windows: [{ day, start, end }] → "Mon 08:00–17:00, Wed 09:00–15:00"
  if (
    Array.isArray(client.availability_windows) &&
    client.availability_windows.length > 0
  ) {
    row.Availability_Windows = client.availability_windows
      .map((w) => `${normDay(w.day)} ${w.start}–${w.end}`)
      .join(", ");
  }

  // Tag "Do Not Rehire" → campo custom checkbox en Zoho CRM
  if (Array.isArray(client.tags)) {
    row.Do_Not_Rehire = client.tags.includes("Do Not Rehire");
  }

  return row;
}

// ── Lead sync — usa upsert por Email para evitar duplicados ───────────────────
// El formulario de booking puede enviarse varias veces con el mismo email
// (re-intentos del usuario, pruebas, etc.). Antes esto creaba un Lead nuevo
// cada vez (POST directo). Ahora usamos Leads/upsert con duplicate_check_fields
// = Email, igual patrón que ya usa el script batch en syncToZoho.js: si el
// email ya existe, Zoho actualiza ese registro en vez de crear uno nuevo.

export async function sendLeadToZoho(leadData) {
  try {
    const token = await getAccessToken();

    const fullName = leadData.fullName || "";
    const parts = fullName.trim().split(" ").filter(Boolean);
    let firstName = "";
    let lastName = "";
    if (parts.length === 0) {
      lastName = "Landing Lead";
    } else if (parts.length === 1) {
      lastName = parts[0];
    } else {
      firstName = parts[0];
      lastName = parts.slice(1).join(" ");
    }

    let description =
      `Service: ${leadData.serviceOption || ""}\n` +
      `Frequency: ${leadData.cleaningFrequency || ""}\n` +
      `Property: ${leadData.propertySize || ""}\n` +
      `Bedrooms: ${leadData.bedrooms || ""}\n` +
      `Bathrooms: ${leadData.fullBathrooms || ""}\n` +
      `Cleaning Date: ${leadData.cleaningDate || ""}`;

    if (leadData.additionalMessage) {
      description += `\n\n--- Additional Message ---\n${leadData.additionalMessage}`;
    }

    const zohoPayload = {
      data: [
        {
          First_Name: firstName,
          Last_Name: lastName,
          Email: leadData.email,
          Phone: leadData.phone || "",
          Mailing_Street: leadData.address || "",
          Lead_Source: "Website Form",
          Description: description,
        },
      ],
      duplicate_check_fields: ["Email"],
    };

    const response = await axios.post(
      `${ZOHO_API_DOMAIN}/crm/v2/Leads/upsert`,
      zohoPayload,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(
      "📨 Respuesta Zoho CRM (upsert):",
      JSON.stringify(response.data, null, 2),
    );

    const first = response.data?.data?.[0];
    if (!first || first.code !== "SUCCESS") {
      console.error("❌ Error al hacer upsert del lead en Zoho:", response.data);
      throw new Error(first?.message || "Zoho CRM error");
    }

    const action = first.action === "update" ? "updated" : "created";
    console.log(
      `📨 Lead ${action} en Zoho: ${first.details.id} (email: ${leadData.email})`,
    );

    return { id: first.details.id, status: "success", action };
  } catch (error) {
    if (error.response?.status === 401) {
      console.warn(
        "⚠️ Access token Zoho expirado, refrescando y reintentando...",
      );
      await refreshAccessToken();
      return sendLeadToZoho(leadData);
    }
    console.error(
      "❌ Error al enviar lead a Zoho:",
      error.response?.data || error.message,
    );
    throw error;
  }
}


// ── Client (Contact) sync — nuevo ────────────────────────────────────────────

// Los IDs de registro de Zoho CRM (Contacts, Leads, etc.) son siempre
// numéricos puros — nunca llevan prefijo. Un valor como "zcrm_52030..."
// (visto en un cliente real, ver postmortem INVALID_URL_PATTERN) no es un
// formato válido de la API de CRM — probablemente coló de otro contexto de
// Zoho (Books, un export/import manual) que sí prefija sus IDs así. Si se
// usa tal cual en la URL del PUT, Zoho devuelve INVALID_URL_PATTERN.
const ZOHO_CRM_ID_PATTERN = /^\d+$/;

function isValidZohoContactId(id) {
  return typeof id === "string" && ZOHO_CRM_ID_PATTERN.test(id);
}

/**
 * Upsert de un Contact en Zoho para un cliente del dashboard.
 *
 * Estrategia:
 *   1. Si el cliente ya tiene zoho_contact_id con formato válido → PUT directo.
 *   2. Si tiene email → busca por email; si encuentra, actualiza y retorna el id.
 *   3. Si no hay match → POST (crea nuevo Contact).
 *
 * @param {object} client  — fila completa de Supabase clients
 * @returns {Promise<string|null>}  zoho Contact id, o null si falla
 */
export async function syncClientToZoho(client) {
  const payload = buildContactPayload(client);

  if (!payload.Last_Name) {
    console.warn(`[Zoho] Skipping sync para client ${client.id} — sin nombre`);
    return null;
  }

  try {
    const token = await getAccessToken();
    const headers = {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    };

    // 1. Tenemos zoho_contact_id guardado y con formato válido → actualizamos directo
    if (client.zoho_contact_id && isValidZohoContactId(client.zoho_contact_id)) {
      await axios.put(
        `${ZOHO_API_DOMAIN}/crm/v2/Contacts/${client.zoho_contact_id}`,
        { data: [payload] },
        { headers },
      );
      console.log(
        `[Zoho] ✅ Contact actualizado: ${client.zoho_contact_id} (client ${client.id})`,
      );
      return client.zoho_contact_id;
    }

    if (client.zoho_contact_id && !isValidZohoContactId(client.zoho_contact_id)) {
      console.warn(
        `[Zoho] zoho_contact_id con formato inválido para client ${client.id}: "${client.zoho_contact_id}" — ignorando y cayendo a búsqueda por email`,
      );
    }

    // 2. Buscar por email
    if (client.email) {
      const searchRes = await axios.get(
        `${ZOHO_API_DOMAIN}/crm/v2/Contacts/search`,
        { params: { email: client.email }, headers },
      );
      const existing = searchRes.data?.data?.[0];
      if (existing?.id) {
        await axios.put(
          `${ZOHO_API_DOMAIN}/crm/v2/Contacts/${existing.id}`,
          { data: [payload] },
          { headers },
        );
        console.log(
          `[Zoho] ✅ Contact actualizado por email: ${existing.id} (client ${client.id})`,
        );
        return existing.id;
      }
    }

    // 3. Crear nuevo Contact
    const createRes = await axios.post(
      `${ZOHO_API_DOMAIN}/crm/v2/Contacts`,
      { data: [payload] },
      { headers },
    );
    const first = createRes.data?.data?.[0];
    if (!first || first.code !== "SUCCESS") {
      console.error(
        "[Zoho] Error al crear Contact — payload enviado:",
        JSON.stringify(payload, null, 2),
      );
      console.error(
        "[Zoho] Respuesta Zoho:",
        JSON.stringify(createRes.data, null, 2),
      );
      return null;
    }
    const newId = first.details?.id ?? null;
    console.log(`[Zoho] ✅ Contact creado: ${newId} (client ${client.id})`);
    return newId;
  } catch (error) {
    if (error.response?.status === 401) {
      console.warn(
        "[Zoho] Token expirado, refrescando y reintentando syncClientToZoho...",
      );
      await refreshAccessToken();
      return syncClientToZoho(client);
    }
    // No-fatal: el error no rompe la respuesta HTTP al admin
    console.error(
      `[Zoho] ❌ syncClientToZoho falló para client ${client.id}:`,
      error.response?.data || error.message,
    );
    return null;
  }
}

/**
 * Wrapper: sync + guarda el zoho_contact_id en Supabase si cambió.
 *
 * Usar en el controller así:
 *   syncAndPersistZohoId(supabase, savedClient).catch(() => {});
 *
 * @param {object} supabase  — instancia del cliente Supabase
 * @param {object} client    — fila completa de Supabase clients
 */
export async function syncAndPersistZohoId(supabase, client) {
  const zohoId = await syncClientToZoho(client);
  if (zohoId && zohoId !== client.zoho_contact_id) {
    const { error } = await supabase
      .from("clients")
      .update({ zoho_contact_id: zohoId, updated_at: new Date().toISOString() })
      .eq("id", client.id);
    if (error) {
      console.error(
        `[Zoho] No se pudo guardar zoho_contact_id para client ${client.id}:`,
        error.message,
      );
    }
  }
  return zohoId;
}