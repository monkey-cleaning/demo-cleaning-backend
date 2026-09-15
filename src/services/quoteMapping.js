import { calculateQuote } from "./cleaningQuoteCalculator.js";

// Enums que expone la tool `calculate_cleaning_quote` en ElevenLabs → forma
// canónica que entiende cleaningQuoteCalculator.js. Se aceptan además algunos
// alias por si el LLM manda una variante del transcript.
//
// Módulo puro (solo depende del calculador) para poder testearlo sin BD.
//
// Portado de Monkey Cleaning (LAB290). Diferencia con el original: allá
// calculateQuote() acepta un 2º arg { isNewClient } para una tarifa base
// diferencial — el calculador de este fork no lo usa (tarifa única), así que
// acá no se pasa.

export const FREQUENCY_ALIASES = {
  weekly: "Weekly",
  "every week": "Weekly",
  "bi-weekly": "Bi-weekly",
  biweekly: "Bi-weekly",
  "bi weekly": "Bi-weekly",
  "every other week": "Bi-weekly",
  "every two weeks": "Bi-weekly",
  fortnightly: "Bi-weekly",
  monthly: "Monthly",
  "once a month": "Monthly",
  "one time": "One Time",
  "one-time": "One Time",
  "one time cleaning": "One Time",
  "one-off": "One Time",
  "just once": "One Time",
  "move in/out": "Move In/Out",
  "move in/move out": "Move In/Out",
  "move in": "Move In/Out",
  "move out": "Move In/Out",
  "move-in/move-out": "Move In/Out",
};

export const BEDROOMS_ALIASES = {
  studio: "Studio",
  bachelor: "Studio",
  "one bedroom": "One Bedroom",
  "1 bedroom": "One Bedroom",
  "two bedrooms": "Two Bedrooms",
  "2 bedrooms": "Two Bedrooms",
  "three bedrooms": "Three Bedrooms",
  "3 bedrooms": "Three Bedrooms",
  "four bedrooms": "Four Bedrooms",
  "4 bedrooms": "Four Bedrooms",
  "four or more bedrooms": "Four Bedrooms",
};

export const FULL_BATHS_ALIASES = {
  "1 bathroom": "1 Bathroom",
  "one bathroom": "1 Bathroom",
  "2 bathrooms": "2 Bathrooms",
  "two bathrooms": "2 Bathrooms",
  "3 bathrooms": "3 Bathrooms",
  "three bathrooms": "3 Bathrooms",
  "4+ bathrooms": "4+ Bathrooms",
  "4 bathrooms": "4+ Bathrooms",
  "four bathrooms": "4+ Bathrooms",
  "four or more bathrooms": "4+ Bathrooms",
};

export const HALF_BATHS_ALIASES = {
  "0 half bathrooms": "0 Half Bathrooms",
  none: "0 Half Bathrooms",
  "1 half bathroom": "1 Half Bathroom",
  "one half bathroom": "1 Half Bathroom",
  "2 half bathrooms": "2 Half Bathrooms",
  "two half bathrooms": "2 Half Bathrooms",
  "3+ half bathrooms": "3+ Half Bathrooms",
  "3 half bathrooms": "3+ Half Bathrooms",
};

export const PROPERTY_SIZE_ALIASES = {
  "under 1000 sq ft": "Under 1000 Sq Ft",
  "1000 - 1499 sq ft": "1000 - 1499 Sq Ft",
  "1500 - 1999 sq ft": "1500 - 1999 Sq Ft",
  "2000 - 2499 sq ft": "2000 - 2499 Sq Ft",
  "2500+ sq ft": "2500+ Sq Ft",
};

function pick(map, value) {
  if (value === undefined || value === null || value === "") return undefined;
  return map[String(value).trim().toLowerCase()];
}

function yesNo(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "yes" || s === "true") return "yes";
  if (s === "no" || s === "false") return "no";
  return undefined;
}

/**
 * Núcleo puro (sin req/res, sin BD) de POST /api/quote/calculate.
 * @param {object} body  campos snake_case tal cual los manda la tool
 * @returns {{ httpStatus: number, payload: object, lead?: object, result?: object }}
 */
export function computeQuoteResponse(body = {}) {
  const missing = ["cleaning_frequency", "bedrooms", "full_bathrooms"].filter(
    (f) => !body[f],
  );
  if (missing.length > 0) {
    return {
      httpStatus: 400,
      payload: {
        error: `missing required field(s): ${missing.join(", ")}`,
        code: "VALIDATION_ERROR",
      },
    };
  }

  const cleaningFrequency = pick(FREQUENCY_ALIASES, body.cleaning_frequency);
  const bedrooms = pick(BEDROOMS_ALIASES, body.bedrooms);
  const fullBathrooms = pick(FULL_BATHS_ALIASES, body.full_bathrooms);

  if (!cleaningFrequency) {
    return {
      httpStatus: 400,
      payload: {
        error:
          "invalid cleaning_frequency; expected one of: Weekly, Bi-weekly, Monthly, One Time, Move In/Out",
        code: "VALIDATION_ERROR",
      },
    };
  }
  if (!bedrooms) {
    return {
      httpStatus: 400,
      payload: {
        error:
          "invalid bedrooms; expected one of: Studio, One Bedroom, Two Bedrooms, Three Bedrooms, Four Bedrooms",
        code: "VALIDATION_ERROR",
      },
    };
  }
  if (!fullBathrooms) {
    return {
      httpStatus: 400,
      payload: {
        error:
          "invalid full_bathrooms; expected one of: 1 Bathroom, 2 Bathrooms, 3 Bathrooms, 4+ Bathrooms",
        code: "VALIDATION_ERROR",
      },
    };
  }

  // Opcionales: si vienen inválidos se ignoran (no rompen la cotización).
  const lead = {
    cleaningFrequency,
    bedrooms,
    fullBathrooms,
    halfBathrooms: pick(HALF_BATHS_ALIASES, body.half_bathrooms),
    propertySize: pick(PROPERTY_SIZE_ALIASES, body.property_size),
    insideFridge: yesNo(body.inside_fridge),
    insideFreezer: yesNo(body.inside_freezer),
    insideOven: yesNo(body.inside_oven),
  };

  const result = calculateQuote(lead);

  const displayType =
    cleaningFrequency === "Move In/Out"
      ? "move in/out"
      : cleaningFrequency === "One Time"
        ? "one-time"
        : "recurring";

  return {
    httpStatus: 200,
    lead,
    result,
    payload: {
      calc_type: displayType,
      currency: "CAD",
      hourly_rate_cad: result.hourlyRate,
      estimated_labor_hours: result.totalHrs,
      hours_per_cleaner: result.hrsPerPerson,
      estimated_total_cad: result.totalAmount,
      tax_note: "Estimate is before applicable taxes (GST).",
      billing_note:
        "Final charge is based on the actual time worked; if the team finishes sooner, the customer pays less.",
    },
  };
}
