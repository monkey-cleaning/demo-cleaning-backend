import "dotenv/config";
import OAuthClient from "intuit-oauth";
import { supabase } from "./supabaseService.js";

const QB_IS_PRODUCTION =
  (process.env.QB_ENVIRONMENT || "production") === "production";

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: QB_IS_PRODUCTION ? "production" : "sandbox",
  redirectUri: process.env.QB_REDIRECT_URI,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry a fn up to `attempts` times with exponential backoff.
// Only retries on network errors (TypeError: fetch failed / ECONNREFUSED).
async function withRetry(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isNetwork =
        err instanceof TypeError ||
        err.code === "ECONNREFUSED" ||
        err.code === "ENOTFOUND";
      if (!isNetwork || i === attempts - 1) throw err;
      const delay = baseDelayMs * 2 ** i;
      console.warn(
        `[QB Retry] Intento ${i + 1} fallido (${err.message}), reintentando en ${delay}ms...`,
      );
      await sleep(delay);
      lastErr = err;
    }
  }
  throw lastErr;
}
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 200; // delay entre páginas para no quemar el rate limit

// ─── TOKEN PERSISTENCE ───────────────────────────────────────────────────────

async function saveTokens(tokenJson) {
  const { error } = await supabase.from("quickbooks_tokens").upsert(
    {
      realm_id: tokenJson.realmId,
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      token_type: tokenJson.token_type || null,
      expires_in: tokenJson.expires_in || null,
      x_refresh_token_expires_in: tokenJson.x_refresh_token_expires_in || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "realm_id" },
  );

  if (error) throw error;
  console.log(
    "💾 QuickBooks tokens guardados en Supabase. realmId:",
    tokenJson.realmId,
  );
}

async function loadTokens() {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    realmId: data.realm_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    x_refresh_token_expires_in: data.x_refresh_token_expires_in,
    updated_at: data.updated_at,
  };
}

// ─── AUTH FLOW ───────────────────────────────────────────────────────────────

export function getAuthorizationUrl() {
  return oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: "monkey-cleaning-qb",
  });
}

export async function handleCallback(callbackUrl) {
  const authResponse = await oauthClient.createToken(callbackUrl);
  const tokenJson = authResponse.getJson();

  const url = new URL(callbackUrl);
  const realmId = url.searchParams.get("realmId");

  const tokens = { ...tokenJson, realmId };

  await saveTokens(tokens);
  oauthClient.setToken(tokens);

  console.log("✅ QuickBooks tokens obtenidos. realmId:", realmId);
  return tokens;
}

// ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

async function getValidToken() {
  // 1. Cargar desde Supabase si el cliente no tiene token en memoria
  if (!oauthClient.getToken()?.access_token) {
    const stored = await loadTokens();
    if (!stored)
      throw new Error(
        "QuickBooks no autorizado. Completar el flujo OAuth primero.",
      );
    oauthClient.setToken(stored);
    console.log(
      "[QB Token] Tokens cargados desde Supabase. realmId:",
      stored.realmId,
    );
  }

  // 2. Verificar expiración manualmente — no confiar en isAccessTokenValid()
  //    porque la librería intuit-oauth tiene un bug conocido donde devuelve
  //    true incluso con tokens expirados.
  const { data: tokenData, error } = await supabase
    .from("quickbooks_tokens")
    .select("updated_at, expires_in")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  const updatedAt = new Date(tokenData.updated_at).getTime();
  const expiresInMs = (tokenData.expires_in || 3600) * 1000;
  const isExpired = Date.now() > updatedAt + expiresInMs - 60_000; // 1 min de margen

  console.log("[QB Token] ¿Token expirado?", isExpired);

  // 3. Refrescar si expiró
  if (isExpired) {
    try {
      console.log("[QB Token] Refrescando access token...");
      const refreshResponse = await withRetry(() => oauthClient.refresh(), {
        attempts: 3,
        baseDelayMs: 800,
      });
      const refreshed = refreshResponse.getJson();
      const realmId = oauthClient.getToken().realmId;
      const tokens = { ...refreshed, realmId };

      await saveTokens(tokens);
      oauthClient.setToken(tokens);
      console.log("[QB Token] ✅ Token refrescado. realmId:", realmId);
    } catch (refreshErr) {
      console.error("[QB Token] ❌ Error al refrescar:", refreshErr.message);
      throw new Error(
        "No se pudo refrescar el token de QuickBooks. Re-autorizar en /auth/quickbooks",
      );
    }
  }

  return oauthClient.getToken();
}

export async function getRequestConfig() {
  const token = await getValidToken();
  const realmId = token.realmId;
  const baseUrl = QB_IS_PRODUCTION
    ? `https://quickbooks.api.intuit.com/v3/company/${realmId}`
    : `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  return { baseUrl, headers, realmId };
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────
export async function getCustomersWithEmail() {
  const { baseUrl, headers } = await getRequestConfig();
  let allCustomers = [];
  let startPosition = 1;
  let page = 1;

  while (true) {
    // QB IDS query: SELECT * is not supported for Customer — field list required.
    // We fetch every field relevant for contact matching and identity resolution.
    const query = `SELECT * FROM Customer WHERE Active = true MAXRESULTS ${PAGE_SIZE} STARTPOSITION ${startPosition}`;

    const response = await fetch(
      `${baseUrl}/query?query=${encodeURIComponent(query)}`,
      { headers },
    );
    const data = await response.json();
    console.log(
      "[QB DEBUG] Customer raw response:",
      JSON.stringify(data).slice(0, 500),
    );

    if (data?.fault) {
      console.error(
        `[QB] getCustomersWithEmail fault:`,
        JSON.stringify(data.fault),
      );
      break;
    }

    const chunk = (data?.QueryResponse?.Customer ?? []).map(normalizeCustomer);
    allCustomers = allCustomers.concat(chunk);
    console.log(
      `[QB] Customers página ${page}: ${chunk.length} registros (total: ${allCustomers.length})`,
    );

    if (chunk.length < PAGE_SIZE) break;
    startPosition += PAGE_SIZE;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return allCustomers;
}

/**
 * Normaliza un objeto Customer de QB a una forma plana y consistente.
 * Centralizar aquí evita que cada consumidor tenga que saber la estructura
 * anidada de QB (PrimaryEmailAddr.Address, BillAddr.Line1, etc.).
 *
 * @param {object} c  Raw Customer object from QB API
 * @returns {object}  Flat normalized customer
 */
function normalizeCustomer(c) {
  return {
    // Identity
    id: c.Id,
    displayName: c.DisplayName ?? null,
    printOnCheckName: c.PrintOnCheckName ?? null, // nombre legal — útil para e-transfer aliases
    companyName: c.CompanyName ?? null, // para customers comerciales
    givenName: c.GivenName ?? null,
    familyName: c.FamilyName ?? null,
    active: c.Active ?? true,

    // Contact
    email: c.PrimaryEmailAddr?.Address ?? null,
    phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    mobile: c.Mobile?.FreeFormNumber ?? null,

    // Billing address (flattened)
    billAddrLine1: c.BillAddr?.Line1 ?? null,
    billAddrCity: c.BillAddr?.City ?? null,
    billAddrState: c.BillAddr?.CountrySubDivisionCode ?? null,
    billAddrZip: c.BillAddr?.PostalCode ?? null,
    billAddrCountry: c.BillAddr?.Country ?? null,
    billAddrFull:
      [
        c.BillAddr?.Line1,
        c.BillAddr?.City,
        c.BillAddr?.CountrySubDivisionCode,
        c.BillAddr?.PostalCode,
      ]
        .filter(Boolean)
        .join(", ") || null,

    // Metadata
    createdAt: c.MetaData?.CreateTime ?? null,
    updatedAt: c.MetaData?.LastUpdatedTime ?? null,
  };
}

// ─── PAYMENT METHODS ─────────────────────────────────────────────────────────
/**
 * Retorna un objeto { id: name } con todos los PaymentMethods de la cuenta QB.
 * QB no siempre incluye .name en PaymentMethodRef al listar pagos — solo el .value (ID).
 * Este mapa se usa en syncQuickbooks para resolver el nombre en tiempo de sync.
 */
export async function getPaymentMethodsMap() {
  const { baseUrl, headers } = await getRequestConfig();
  const query = `SELECT Id, Name, Active FROM PaymentMethod MAXRESULTS 100`;
  const response = await fetch(
    `${baseUrl}/query?query=${encodeURIComponent(query)}`,
    { headers },
  );
  const data = await response.json();

  if (data?.fault) {
    console.error(
      `[QB] getPaymentMethodsMap fault:`,
      JSON.stringify(data.fault),
    );
    return {};
  }

  const methods = data?.QueryResponse?.PaymentMethod ?? [];
  const map = {};
  for (const m of methods) {
    map[m.Id] = m.Name;
  }
  console.log(`[QB] Payment methods cargados:`, JSON.stringify(map));
  return map;
}

export async function findCustomerByEmail(email) {
  const { baseUrl, headers } = await getRequestConfig();
  const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;
  const response = await fetch(
    `${baseUrl}/query?query=${encodeURIComponent(query)}`,
    { headers },
  );
  const data = await response.json();
  return data?.QueryResponse?.Customer?.[0] ?? null;
}

// Arma BillAddr estructurada cuando tenemos street/city/state/zip/country;
// fallback a Line1 con el string de dirección plano si es lo único disponible.
// Compartida entre createCustomer y ensureCustomerTaxSetup.
function buildBillAddr(leadData) {
  if (leadData.street || leadData.city) {
    return {
      Line1: leadData.street || leadData.address || undefined,
      City: leadData.city || undefined,
      CountrySubDivisionCode: leadData.state || undefined,
      PostalCode: leadData.zip || undefined,
      Country: leadData.country || "CA",
    };
  }
  if (leadData.address) return { Line1: leadData.address };
  return undefined;
}

export async function createCustomer(leadData) {
  const { baseUrl, headers } = await getRequestConfig();
  const parts = (leadData.fullName || "").trim().split(" ").filter(Boolean);
  const firstName = parts.length > 1 ? parts[0] : "";
  const lastName =
    parts.length === 0 ? "Unknown" : parts.slice(1).join(" ") || parts[0];

  // Necesaria para que Automated Sales Tax calcule la tasa correcta (HST BC vs otra).
  const billAddr = buildBillAddr(leadData);

  const payload = {
    GivenName: firstName,
    FamilyName: lastName,
    DisplayName: leadData.fullName || leadData.email,
    PrimaryEmailAddr: { Address: leadData.email },
    PrimaryPhone: leadData.phone
      ? { FreeFormNumber: leadData.phone }
      : undefined,
    BillAddr: billAddr,
    Taxable: true,
  };

  const response = await fetch(`${baseUrl}/customer`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data?.Customer)
    throw new Error(`QB createCustomer error: ${JSON.stringify(data)}`);
  console.log("✅ Customer creado en QuickBooks:", data.Customer.Id);
  return data.Customer;
}

// Si el customer ya existe en QB pero le falta BillAddr o tiene Taxable: false,
// lo actualiza (sparse update — solo manda los campos que cambian, no pisa el
// resto). Ambos casos producen el mismo error de validación al facturar:
// - Sin BillAddr: QB no puede resolver la tasa por ubicación.
// - Taxable: false: QB ignora el TaxCodeRef de las líneas (customer marcado
//   como no-gravable), aunque las líneas digan lo contrario.
// Caso real que motivó esto: customer creado en un intento previo, antes de
// que empezáramos a mandar dirección/Taxable (LAB, ago 2026).
async function ensureCustomerTaxSetup(customer, leadData) {
  const hasAddr = customer.BillAddr?.Line1 || customer.BillAddr?.City;
  const needsTaxableFix = customer.Taxable === false;
  if (hasAddr && !needsTaxableFix) return customer;

  const patch = {
    Id: customer.Id,
    SyncToken: customer.SyncToken,
    sparse: true,
  };
  if (!hasAddr) {
    const billAddr = buildBillAddr(leadData);
    if (billAddr) patch.BillAddr = billAddr;
  }
  if (needsTaxableFix) patch.Taxable = true;

  // Nada que actualizar (ni dirección disponible ni Taxable que arreglar)
  if (!patch.BillAddr && !("Taxable" in patch)) return customer;

  const { baseUrl, headers } = await getRequestConfig();
  const response = await fetch(`${baseUrl}/customer`, {
    method: "POST",
    headers,
    body: JSON.stringify(patch),
  });
  const data = await response.json();
  if (!data?.Customer) {
    console.warn(
      `[QB] No se pudo actualizar tax setup del customer ${customer.Id}:`,
      JSON.stringify(data),
    );
    return customer;
  }
  console.log(`[QB] ✅ Tax setup sincronizado para customer ${customer.Id}`);
  return data.Customer;
}

export async function findOrCreateCustomer(leadData) {
  const existing = await findCustomerByEmail(leadData.email);
  if (existing) {
    console.log("ℹ️ Customer ya existe en QB:", existing.Id);
    return ensureCustomerTaxSetup(existing, leadData);
  }
  return createCustomer(leadData);
}

// ─── INVOICES ────────────────────────────────────────────────────────────────

// taxCode: Id real de TaxCode en esta cuenta QB (no "TAX"/"NON" — esta cuenta
// usa códigos manuales nombrados, no el esquema simplificado de AST). Default
// "4" = GST (5%), confirmado contra una invoice histórica real (LAB, ago 2026).
// BC no aplica PST a servicios de limpieza, por eso no es "8"/"9"/"10".
export async function createInvoice(
  customer,
  lineItems,
  dueDate = null,
  taxCode = "4",
) {
  const { baseUrl, headers } = await getRequestConfig();
  const lines = lineItems.map((item, i) => ({
    Id: String(i + 1),
    Amount: item.amount,
    DetailType: "SalesItemLineDetail",
    Description: item.description,
    SalesItemLineDetail: {
      UnitPrice: item.amount,
      Qty: 1,
      TaxCodeRef: { value: taxCode },
    },
  }));

  const payload = {
    CustomerRef: { value: customer.Id },
    Line: lines,
    // Requerido para compañías fuera de EE.UU. con sales tax (Canadá incluido).
    // Sin esto, aunque las líneas tengan TaxCodeRef, QB nunca dispara el cálculo
    // de Automated Sales Tax y responde "Make sure all your transactions have
    // a GST/HST rate before you save" — mismo error que TaxCodeRef ausente.
    GlobalTaxCalculation: "TaxExcluded",
    // Sin BillEmail, /invoice/:id/send tira NullPointerException del lado de
    // QB en vez de un error claro. No alcanza con que el customer tenga
    // PrimaryEmailAddr — la invoice necesita su propio BillEmail (LAB, ago 2026).
    ...(customer.PrimaryEmailAddr?.Address
      ? { BillEmail: { Address: customer.PrimaryEmailAddr.Address } }
      : {}),
    ...(dueDate ? { DueDate: dueDate } : {}),
  };

  const response = await fetch(`${baseUrl}/invoice`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data?.Invoice)
    throw new Error(`QB createInvoice error: ${JSON.stringify(data)}`);
  console.log("✅ Invoice creada en QuickBooks:", data.Invoice.Id);
  return data.Invoice;
}

export async function getInvoice(invoiceId) {
  const { baseUrl, headers } = await getRequestConfig();
  const response = await fetch(`${baseUrl}/invoice/${invoiceId}`, { headers });
  const data = await response.json();
  return data?.Invoice ?? null;
}

export async function getInvoicesSince(fromDate) {
  const { baseUrl, headers } = await getRequestConfig();
  let allInvoices = [];
  let startPosition = 1;
  let page = 1;

  while (true) {
    const query = `SELECT * FROM Invoice WHERE TxnDate >= '${fromDate}' ORDERBY TxnDate DESC MAXRESULTS ${PAGE_SIZE} STARTPOSITION ${startPosition}`;
    const response = await withRetry(() =>
      fetch(`${baseUrl}/query?query=${encodeURIComponent(query)}`, { headers }),
    );

    if (!response.ok) {
      console.error(
        `[QB] getInvoicesSince HTTP ${response.status} en página ${page} — reintentando en 3s...`,
      );
      await sleep(3000);
      continue;
    }

    const data = await response.json();

    // Si QB devuelve un error de auth u otro fault, cortar
    if (data?.fault) {
      console.error(`[QB] getInvoicesSince fault:`, JSON.stringify(data.fault));
      break;
    }

    const chunk = data?.QueryResponse?.Invoice ?? [];
    allInvoices = allInvoices.concat(chunk);
    console.log(
      `[QB] Invoices página ${page}: ${chunk.length} registros (total: ${allInvoices.length})`,
    );

    if (chunk.length < PAGE_SIZE) break; // última página

    startPosition += PAGE_SIZE;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return allInvoices;
}

// ─── PAYMENTS ────────────────────────────────────────────────────────────────

export async function createPayment(customer, invoice, amount) {
  const { baseUrl, headers } = await getRequestConfig();
  const payload = {
    CustomerRef: { value: customer.Id },
    TotalAmt: amount,
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }],
      },
    ],
  };

  const response = await fetch(`${baseUrl}/payment`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data?.Payment)
    throw new Error(`QB createPayment error: ${JSON.stringify(data)}`);
  console.log("✅ Payment registrado en QuickBooks:", data.Payment.Id);
  return data.Payment;
}

export async function getPaymentsSince(fromDate) {
  const { baseUrl, headers } = await getRequestConfig();
  let allPayments = [];
  let startPosition = 1;
  let page = 1;

  while (true) {
    const query = `SELECT * FROM Payment WHERE TxnDate >= '${fromDate}' ORDERBY TxnDate DESC MAXRESULTS ${PAGE_SIZE} STARTPOSITION ${startPosition}`;
    const response = await withRetry(() =>
      fetch(`${baseUrl}/query?query=${encodeURIComponent(query)}`, { headers }),
    );

    if (!response.ok) {
      console.error(
        `[QB] getPaymentsSince HTTP ${response.status} en página ${page}`,
      );
      break;
    }

    const data = await response.json();

    if (data?.fault) {
      console.error(`[QB] getPaymentsSince fault:`, JSON.stringify(data.fault));
      break;
    }

    const chunk = data?.QueryResponse?.Payment ?? [];
    allPayments = allPayments.concat(chunk);
    console.log(
      `[QB] Payments página ${page}: ${chunk.length} registros (total: ${allPayments.length})`,
    );

    if (chunk.length < PAGE_SIZE) break;

    startPosition += PAGE_SIZE;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return allPayments;
}
