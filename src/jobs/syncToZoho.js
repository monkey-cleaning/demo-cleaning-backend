import 'dotenv/config';
import axios from 'axios';
import pkg from 'xlsx';
const { readFile, utils } = pkg;
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ZOHO_TOKEN_URL    = 'https://accounts.zohocloud.ca/oauth/v2/token';
const ZOHO_API_DOMAIN   = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.ca';
const EXCEL_FILE_PATH   = process.env.EXCEL_FILE_PATH || './src/data/Leads_CRM.xlsx';
const SHEET_NAME        = 'CRM-Zoho';

// Rate-limit: Zoho Free/Standard allows ~10 req/s on bulk endpoints
// Usamos upsert masivo de hasta 100 registros por llamada
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 300;

// ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

let accessToken = '';
let accessTokenExpiresAt = 0;

async function refreshAccessToken() {
  const response = await axios.post(ZOHO_TOKEN_URL, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });

  accessToken = response.data.access_token;
  const expiresIn = response.data.expires_in ?? 3600;
  accessTokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
  console.log('🔑 Access token Zoho renovado. Expira en', expiresIn, 's');
  return accessToken;
}

async function getToken() {
  if (!accessToken || Date.now() >= accessTokenExpiresAt) {
    return refreshAccessToken();
  }
  return accessToken;
}

// ─── ZOHO HELPERS ────────────────────────────────────────────────────────────

/**
 * Busca leads existentes en Zoho por email (para evitar duplicados).
 * Devuelve un Map<email_lowercase, zoho_id>
 */
async function fetchExistingLeadsByEmail(emails) {
  const token = await getToken();
  const existingMap = new Map();

  // Zoho COQL: máx 200 registros por consulta
  // Dividimos en lotes de 200 emails
  const COQL_BATCH = 50; // COQL IN list tiene límite práctico ~50
  for (let i = 0; i < emails.length; i += COQL_BATCH) {
    const chunk = emails.slice(i, i + COQL_BATCH);
    const emailList = chunk.map(e => `'${e}'`).join(',');
    const query = `SELECT id, Email FROM Leads WHERE Email IN (${emailList}) LIMIT 200`;

    try {
      const resp = await axios.post(
        `${ZOHO_API_DOMAIN}/crm/v2/coql`,
        { select_query: query },
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const records = resp.data?.data || [];
      for (const r of records) {
        if (r.Email) existingMap.set(r.Email.toLowerCase(), r.id);
      }
    } catch (err) {
      // COQL puede fallar si no hay resultados — es normal
      if (err.response?.status !== 204 && err.response?.data?.errorCode !== 'SYNTAX_ERROR') {
        console.warn('⚠️  COQL batch error:', err.response?.data || err.message);
      }
    }

    await sleep(200);
  }

  return existingMap;
}

/**
 * Upsert masivo de leads en Zoho (hasta 100 por llamada).
 * Si el lead ya existe (por email), lo actualiza; si no, lo crea.
 */
async function upsertLeadsBatch(leads, existingMap) {
  const token = await getToken();

  const data = leads.map(lead => {
    const row = buildZohoRow(lead);
    const existingId = existingMap.get((lead.email || '').toLowerCase());
    if (existingId) row.id = existingId; // Zoho usa el campo `id` para update en upsert
    return row;
  });

  const response = await axios.post(
    `${ZOHO_API_DOMAIN}/crm/v2/Leads/upsert`,
    { data, duplicate_check_fields: ['Email'] },
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const results = response.data?.data || [];
  let created = 0, updated = 0, errors = 0;

  for (const r of results) {
    if (r.code === 'SUCCESS') {
      if (r.action === 'insert') created++;
      else updated++;
    } else {
      errors++;
      console.error('  ❌ Error en lead:', r.message, '|', r.details);
    }
  }

  return { created, updated, errors };
}

function buildZohoRow(lead) {
  const fullName = (lead.fullName || '').trim();
  const parts    = fullName.split(' ').filter(Boolean);

  let firstName = '';
  let lastName  = fullName || 'Unknown';

  if (parts.length === 1) {
    lastName = parts[0];
  } else if (parts.length > 1) {
    firstName = parts[0];
    lastName  = parts.slice(1).join(' ');
  }

  // Construimos la descripción con los datos extra disponibles
  const descParts = [];
  if (lead.serviceType)     descParts.push(`Service: ${lead.serviceType}`);
  if (lead.rate)            descParts.push(`Rate: $${lead.rate}/hr`);
  if (lead.paymentMethod)   descParts.push(`Payment: ${lead.paymentMethod}`);
  if (lead.notes)           descParts.push(`Notes: ${lead.notes}`);
  if (lead.source)          descParts.push(`Source: ${lead.source}`);

  return {
    First_Name:     firstName,
    Last_Name:      lastName,
    Email:          lead.email || '',
    Phone:          lead.phone || '',
    Mailing_Street: lead.street || '',
    Mailing_City:   lead.city   || '',
    Mailing_State:  lead.state  || '',
    Mailing_Zip:    lead.zip    || '',
    Mailing_Country: lead.country || 'Canada',
    Company:        lead.company || '',
    Lead_Source:    lead.leadSource || 'CRM Import',
    Lead_Status:    lead.status === 'Active' ? 'Contacted' : 'Not Contacted',
    Description:    descParts.join('\n'),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 1. LEER EXCEL ───────────────────────────────────────────────────────────

function readExcelLeads(filePath) {
  console.log(`\n📄 Leyendo Excel: ${filePath}`);
  const wb = readFile(filePath);

  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new Error(`Hoja "${SHEET_NAME}" no encontrada. Hojas disponibles: ${wb.SheetNames.join(', ')}`);
  }

  const ws   = wb.Sheets[SHEET_NAME];
  const rows = utils.sheet_to_json(ws, { defval: '' });

  const leads = [];

  for (const row of rows) {
    // Las columnas del Excel tienen espacios/variaciones — normalizar
    const firstName  = String(row['Customer Last Name'] || '').trim(); // columna A (contiene el first name en el sheet)
    const lastName   = String(row['Company'] !== '' && !row['Unnamed: 2'] ? '' : (Object.values(row)[1] || '')).trim();

    // El Excel tiene columnas: "Customer Last Name" | (unnamed col with last name) | Company | Email | Phone | Street | City | Zip Code | State | Country | Rate | Type of Service | Status | Notes | Payment Method
    // Parseamos por posición usando sheet_to_json con header:1 para mayor control
    const email = String(row['Email'] || '').trim().toLowerCase().replace(/[<>]/g, '');
    const phone         = String(row['Phone']            || '').trim().replace(/[.\s]/g, '-');
    const street        = String(row['Street']           || '').trim();
    const city          = String(row['City']             || '').trim();
    const zip           = String(row['Zip Code']         || '').trim();
    const state         = String(row['State']            || '').trim();
    const country       = String(row['Country']         || 'Canada').trim().replace('Canadá','Canada');
    const rate          = String(row['Rate']             || '').trim();
    const serviceType   = String(row['Type of Service']  || '').trim();
    const status        = String(row['Status']           || '').trim();
    const notes         = String(row['Notes']            || '').trim();
    const paymentMethod = String(row['Payment Method']   || '').trim();
    const company       = String(row['Company']          || '').trim();

    // Ignorar filas sin email
    if (!email || !email.includes('@')) continue;

    // Reconstruir fullName de las primeras dos columnas del sheet
    // El sheet tiene "Customer Last Name" como header de col A pero en realidad guarda "First Last"
    const rawCol0 = String(Object.values(row)[0] || '').trim(); // Ej: "Adam "
    const rawCol1 = String(Object.values(row)[1] || '').trim(); // Ej: "Ridley"
    const fullName = company
      ? company
      : [rawCol0, rawCol1].filter(Boolean).join(' ').trim();

    leads.push({
      fullName,
      company,
      email,
      phone,
      street,
      city,
      zip,
      state,
      country,
      rate,
      serviceType,
      status,
      notes,
      paymentMethod,
      leadSource: 'CRM Import',
    });
  }

  // Deduplicar por email (nos quedamos con el último registro)
  const deduped = new Map();
  for (const lead of leads) {
    deduped.set(lead.email, lead);
  }

  console.log(`  ✅ ${rows.length} filas leídas → ${deduped.size} leads únicos con email`);
  return Array.from(deduped.values());
}

// ─── 2. LEER CLIENTES DE QUICKBOOKS ──────────────────────────────────────────

/**
 * Esta función importa y usa getCustomersWithEmail de quickbooksService.js
 * Si no está disponible (entorno standalone), retorna vacío con advertencia.
 */
async function readQuickBooksLeads() {
  console.log('\n📦 Leyendo clientes de QuickBooks...');
  try {
    const { getCustomersWithEmail } = await import('../services/quickbooksService.js');
    const customers = await getCustomersWithEmail();

    const leads = customers
      .filter(c => c.PrimaryEmailAddr?.Address)
      .map(c => {
        const email     = c.PrimaryEmailAddr.Address.trim().toLowerCase();
        const firstName = c.GivenName  || '';
        const lastName  = c.FamilyName || c.DisplayName || 'Unknown';
        const fullName  = `${firstName} ${lastName}`.trim();
        const company   = c.CompanyName || '';

        return {
          fullName,
          company,
          email,
          phone:       c.PrimaryPhone?.FreeFormNumber || '',
          street:      c.BillAddr?.Line1 || '',
          city:        c.BillAddr?.City  || '',
          zip:         c.BillAddr?.PostalCode || '',
          state:       c.BillAddr?.CountrySubDivisionCode || '',
          country:     c.BillAddr?.Country || 'Canada',
          serviceType: '',
          status:      c.Active ? 'Active' : 'Inactive',
          notes:       `QuickBooks Customer ID: ${c.Id}`,
          leadSource:  'QuickBooks',
        };
      });

    const deduped = new Map();
    for (const lead of leads) deduped.set(lead.email, lead);

    console.log(`  ✅ ${customers.length} customers QB → ${deduped.size} leads únicos con email`);
    return Array.from(deduped.values());
  } catch (err) {
    console.warn(`  ⚠️  No se pudo importar quickbooksService.js: ${err.message}`);
    console.warn('  ℹ️  Continuando solo con el Excel.');
    return [];
  }
}

// ─── 3. SYNC MASIVO A ZOHO ───────────────────────────────────────────────────

async function syncLeadsToZoho(leads) {
  if (!leads.length) {
    console.log('  ℹ️  Sin leads para sincronizar.');
    return;
  }

  console.log(`\n🚀 Sincronizando ${leads.length} leads a Zoho CRM...`);

  // Obtener emails existentes para hacer upsert inteligente
  const emails = leads.map(l => l.email).filter(Boolean);
  console.log('  🔍 Consultando leads existentes en Zoho...');
  const existingMap = await fetchExistingLeadsByEmail(emails);
  console.log(`  📊 ${existingMap.size} leads ya existían en Zoho`);

  let totalCreated = 0, totalUpdated = 0, totalErrors = 0;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch     = leads.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(leads.length / BATCH_SIZE);

    process.stdout.write(`  📤 Batch ${batchNum}/${totalBatches} (${batch.length} leads)... `);

    try {
      const { created, updated, errors } = await upsertLeadsBatch(batch, existingMap);
      totalCreated += created;
      totalUpdated += updated;
      totalErrors  += errors;
      console.log(`✅ +${created} creados, ~${updated} actualizados, ❌${errors} errores`);
    } catch (err) {
      totalErrors += batch.length;
      console.error(`\n  ❌ Error en batch ${batchNum}:`, err.response?.data || err.message);

      // Si es 401, renovar token y reintentar
      if (err.response?.status === 401) {
        console.log('  🔄 Renovando token y reintentando...');
        await refreshAccessToken();
        const { created, updated, errors } = await upsertLeadsBatch(batch, existingMap);
        totalCreated += created;
        totalUpdated += updated;
        totalErrors  = totalErrors - batch.length + errors;
      }
    }

    if (i + BATCH_SIZE < leads.length) await sleep(BATCH_DELAY_MS);
  }

  return { totalCreated, totalUpdated, totalErrors };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🐒 Monkey Cleaning — Sync to Zoho CRM');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════');

  // Validar variables de entorno
  const required = ['ZOHO_REFRESH_TOKEN', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Faltan variables de entorno:', missing.join(', '));
    process.exit(1);
  }

  // Obtener token inicial
  await refreshAccessToken();

  // ── Fuente 1: Excel
  const excelLeads = readExcelLeads(EXCEL_FILE_PATH);

  // ── Fuente 2: QuickBooks
  const qbLeads = await readQuickBooksLeads();

  // ── Merge: QB tiene prioridad si mismo email (datos más frescos)
  const mergedMap = new Map();
  for (const lead of excelLeads) mergedMap.set(lead.email, lead);
  for (const lead of qbLeads) {
    const existing = mergedMap.get(lead.email);
    if (existing) {
      // Enriquecer el lead del Excel con datos de QB donde el Excel esté vacío
      mergedMap.set(lead.email, {
        ...existing,
        phone:   existing.phone   || lead.phone,
        street:  existing.street  || lead.street,
        city:    existing.city    || lead.city,
        zip:     existing.zip     || lead.zip,
        company: existing.company || lead.company,
        notes:   [existing.notes, lead.notes].filter(Boolean).join(' | '),
        leadSource: 'CRM Import + QuickBooks',
      });
    } else {
      mergedMap.set(lead.email, lead);
    }
  }

  const allLeads = Array.from(mergedMap.values());

  console.log(`\n📊 Resumen de fuentes:`);
  console.log(`   Excel:       ${excelLeads.length} leads`);
  console.log(`   QuickBooks:  ${qbLeads.length} leads`);
  console.log(`   Total único: ${allLeads.length} leads`);

  // ── Sincronizar a Zoho
  const result = await syncLeadsToZoho(allLeads);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ SYNC COMPLETADO');
  console.log(`  🆕 Creados:     ${result?.totalCreated ?? 0}`);
  console.log(`  🔄 Actualizados: ${result?.totalUpdated ?? 0}`);
  console.log(`  ❌ Errores:     ${result?.totalErrors  ?? 0}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});