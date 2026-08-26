// services/clientExportService.js
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { supabase } from "./supabaseService.js";

const ALLOCATION_TYPE_LABEL = {
  invoice_payment: "Applied to invoice",
  tip: "Tip",
  pending_review: "Pending review",
  credit_balance: "Credit balance",
};

const SOURCE_LABEL = {
  auto_fifo: "Automatic (FIFO)",
  manual: "Manual (admin)",
};

// Brand palette — reused across PDF and XLSX so both exports feel consistent.
const COLORS = {
  brand: "031634", // navy — matches the admin dashboard header
  brandRGB: "#031634",
  headerBg: "#f3f4f6", // gray-100
  headerBgHex: "F3F4F6",
  rowAlt: "#f9fafb", // gray-50
  rowAltHex: "F9FAFB",
  border: "#e5e7eb", // gray-200
  borderHex: "E5E7EB",
  textMuted: "#6b7280", // gray-500
  green: "#047857", // emerald-700
  greenHex: "047857",
  red: "#b91c1c", // red-700
  redHex: "B91C1C",
  amber: "#b45309", // amber-700
  amberHex: "B45309",
};

// Status → color, shared logic for both PDF text and XLSX font color.
function statusColor(status) {
  const s = (status ?? "").toLowerCase();
  if (s === "paid" || s === "completed" || s === "active") return COLORS.green;
  if (s === "overdue" || s === "failed") return COLORS.red;
  if (s === "pending" || s === "pending_review" || s.includes("superseded"))
    return COLORS.amber;
  return COLORS.textMuted;
}
function statusColorHex(status) {
  const s = (status ?? "").toLowerCase();
  if (s === "paid" || s === "completed" || s === "active")
    return COLORS.greenHex;
  if (s === "overdue" || s === "failed") return COLORS.redHex;
  if (s === "pending" || s === "pending_review" || s.includes("superseded"))
    return COLORS.amberHex;
  return "6B7280";
}

function clientDisplayName(client) {
  return (
    client.name ??
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ??
    "Unnamed client"
  );
}

// ── DATA GATHERING ────────────────────────────────────────────────────────────
// Full history, no page limit — this is a report, not a UI list.

export async function getClientExportData(clientId) {
  const [clientRes, invoicesRes, paymentsRes, allocationsRes, totalsRes] =
    await Promise.all([
      supabase
        .from("clients_with_name")
        .select("*")
        .eq("id", clientId)
        .single(),

      supabase
        .from("invoices")
        .select(
          "id, doc_number, quickbooks_invoice_id, total_amount, balance, status, issued_date, due_date, notes",
        )
        .eq("client_id", clientId)
        .order("issued_date", { ascending: true }),

      supabase
        .from("payments")
        .select(
          "id, amount, payment_date, payment_method, status, quickbooks_payment_id",
        )
        .eq("client_id", clientId)
        .order("payment_date", { ascending: true }),

      // Fuente de verdad del matching — incluye superseded para que el reporte
      // muestre también correcciones manuales, no solo el estado final.
      supabase
        .from("payment_allocations")
        .select(
          `id, payment_id, invoice_id, allocation_type, amount, source, note, created_at, superseded_by,
           payment:payments(payment_date, amount, payment_method, quickbooks_payment_id),
           invoice:invoices(doc_number, quickbooks_invoice_id, issued_date)`,
        )
        .eq("client_id", clientId)
        .order("created_at", { ascending: true }),

      supabase
        .from("clients_billing_status")
        .select("total_billed, total_paid, billing_status")
        .eq("client_id", clientId)
        .maybeSingle(),
    ]);

  if (clientRes.error) throw clientRes.error;
  if (!clientRes.data) throw new Error("Client not found");
  if (invoicesRes.error) throw invoicesRes.error;
  if (paymentsRes.error) throw paymentsRes.error;
  if (allocationsRes.error) throw allocationsRes.error;
  if (totalsRes.error) throw totalsRes.error;

  const totalBilled = Number(totalsRes.data?.total_billed ?? 0);
  const totalPaid = Number(totalsRes.data?.total_paid ?? 0);

  return {
    client: clientRes.data,
    invoices: invoicesRes.data ?? [],
    payments: paymentsRes.data ?? [],
    allocations: allocationsRes.data ?? [],
    stats: {
      totalBilled: Number(totalBilled.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      balance: Number((totalBilled - totalPaid).toFixed(2)),
      billingStatus: totalsRes.data?.billing_status ?? null,
    },
  };
}

// ── FILTERING ──────────────────────────────────────────────────────────────
// Los reportes no deben mostrar líneas de $0.00 (invoices anulados sin monto,
// payments de prueba, etc.) — no aportan info y ensucian el PDF/XLSX.
function excludeZeroAmount(records, amountField) {
  return records.filter((r) => Number(r[amountField] ?? 0) !== 0);
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: `FF${COLORS.brand}` },
    };
    cell.alignment = { vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: `FF${COLORS.borderHex}` } },
      bottom: { style: "thin", color: { argb: `FF${COLORS.borderHex}` } },
    };
  });
  row.height = 20;
}

function styleDataRows(
  sheet,
  startRow,
  endRow,
  { statusCol, moneyCols = [] } = {},
) {
  for (let r = startRow; r <= endRow; r++) {
    const row = sheet.getRow(r);
    const isAlt = (r - startRow) % 2 === 1;
    row.eachCell((cell, colNumber) => {
      if (isAlt) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${COLORS.rowAltHex}` },
        };
      }
      cell.border = {
        bottom: { style: "thin", color: { argb: `FF${COLORS.borderHex}` } },
      };
      if (moneyCols.includes(colNumber))
        cell.alignment = { horizontal: "right" };
      if (statusCol && colNumber === statusCol) {
        cell.font = {
          color: { argb: `FF${statusColorHex(cell.value)}` },
          bold: true,
        };
      }
    });
  }
}

export async function buildClientExportXlsx(data) {
  const { client, stats } = data;
  const invoices = excludeZeroAmount(data.invoices, "total_amount");
  const payments = excludeZeroAmount(data.payments, "amount");
  const allocations = excludeZeroAmount(data.allocations, "amount");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Monkey Cleaning Admin";
  wb.created = new Date();

  // ── Summary ──
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Field", key: "field", width: 24 },
    { header: "Value", key: "value", width: 40 },
  ];
  summary.mergeCells("A1:B1");
  const titleCell = summary.getCell("A1");
  titleCell.value = "Monkey Cleaning — Client Billing Report";
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: `FF${COLORS.brand}` },
  };
  titleCell.alignment = { vertical: "middle" };
  summary.getRow(1).height = 26;

  summary.getRow(2).values = ["Field", "Value"];
  styleHeaderRow(summary.getRow(2));

  const summaryRows = [
    ["Client", clientDisplayName(client)],
    ["Email", client.email ?? "—"],
    ["Phone", client.mobile ?? client.phone ?? "—"],
    [
      "Address",
      [client.street, client.city, client.state, client.zip_code]
        .filter(Boolean)
        .join(", ") || "—",
    ],
    ["Status", client.status ?? "—"],
    ["", ""],
    ["Total billed", stats.totalBilled],
    ["Total paid", stats.totalPaid],
    ["Balance", stats.balance],
    ["Billing status", stats.billingStatus ?? "—"],
    ["", ""],
    ["Generated at", new Date().toISOString()],
  ];
  summary.addRows(summaryRows);
  const balanceRowIdx = 3 + summaryRows.findIndex((r) => r[0] === "Balance");
  const balanceCell = summary.getCell(`B${balanceRowIdx}`);
  balanceCell.numFmt = "$#,##0.00";
  balanceCell.font = {
    bold: true,
    color: { argb: `FF${stats.balance > 0 ? COLORS.redHex : COLORS.greenHex}` },
  };
  summary.getCell(
    `B${3 + summaryRows.findIndex((r) => r[0] === "Total billed")}`,
  ).numFmt = "$#,##0.00";
  summary.getCell(
    `B${3 + summaryRows.findIndex((r) => r[0] === "Total paid")}`,
  ).numFmt = "$#,##0.00";
  styleDataRows(summary, 3, summary.rowCount, {});

  // ── Invoices ──
  const invSheet = wb.addWorksheet("Invoices");
  invSheet.columns = [
    { header: "Doc #", key: "doc_number", width: 14 },
    { header: "QB Invoice ID", key: "qb_id", width: 16 },
    { header: "Issued", key: "issued_date", width: 14 },
    { header: "Due", key: "due_date", width: 14 },
    { header: "Total", key: "total_amount", width: 14 },
    { header: "Balance due", key: "balance", width: 14 },
    { header: "Status", key: "status", width: 14 },
  ];
  styleHeaderRow(invSheet.getRow(1));
  invSheet.autoFilter = { from: "A1", to: "G1" };
  invSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const inv of invoices) {
    invSheet.addRow({
      doc_number: inv.doc_number ?? "—",
      qb_id: inv.quickbooks_invoice_id ?? "—",
      issued_date: inv.issued_date ?? "—",
      due_date: inv.due_date ?? "—",
      total_amount: Number(inv.total_amount ?? 0),
      balance: Number(inv.balance ?? 0),
      status: inv.status,
    });
  }
  invSheet.getColumn("total_amount").numFmt = "$#,##0.00";
  invSheet.getColumn("balance").numFmt = "$#,##0.00";
  styleDataRows(invSheet, 2, invSheet.rowCount, {
    statusCol: 7,
    moneyCols: [5, 6],
  });

  // ── Payments ──
  const paySheet = wb.addWorksheet("Payments");
  paySheet.columns = [
    { header: "Date", key: "payment_date", width: 14 },
    { header: "Amount", key: "amount", width: 14 },
    { header: "Method", key: "payment_method", width: 20 },
    { header: "Status", key: "status", width: 14 },
    { header: "QB Payment ID", key: "qb_id", width: 16 },
  ];
  styleHeaderRow(paySheet.getRow(1));
  paySheet.autoFilter = { from: "A1", to: "E1" };
  paySheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const p of payments) {
    paySheet.addRow({
      payment_date: p.payment_date,
      amount: Number(p.amount ?? 0),
      payment_method: p.payment_method ?? "—",
      status: p.status,
      qb_id: p.quickbooks_payment_id ?? "—",
    });
  }
  paySheet.getColumn("amount").numFmt = "$#,##0.00";
  styleDataRows(paySheet, 2, paySheet.rowCount, {
    statusCol: 4,
    moneyCols: [2],
  });

  // ── Matching ──
  const matchSheet = wb.addWorksheet("Matching");
  matchSheet.columns = [
    { header: "Payment date", key: "payment_date", width: 14 },
    { header: "Payment amount", key: "payment_amount", width: 16 },
    { header: "Applied to", key: "applied_to", width: 16 },
    { header: "Applied amount", key: "applied_amount", width: 16 },
    { header: "Type", key: "type", width: 18 },
    { header: "Matched by", key: "source", width: 18 },
    { header: "Note", key: "note", width: 32 },
    { header: "Status", key: "status", width: 20 },
  ];
  styleHeaderRow(matchSheet.getRow(1));
  matchSheet.autoFilter = { from: "A1", to: "H1" };
  matchSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const a of allocations) {
    matchSheet.addRow({
      payment_date: a.payment?.payment_date ?? "—",
      payment_amount: Number(a.payment?.amount ?? 0),
      applied_to: a.invoice?.doc_number
        ? `Invoice #${a.invoice.doc_number}`
        : "—",
      applied_amount: Number(a.amount ?? 0),
      type: ALLOCATION_TYPE_LABEL[a.allocation_type] ?? a.allocation_type,
      source: SOURCE_LABEL[a.source] ?? a.source,
      note: a.note ?? "",
      status: a.superseded_by ? "Superseded (corrected)" : "Active",
    });
  }
  matchSheet.getColumn("payment_amount").numFmt = "$#,##0.00";
  matchSheet.getColumn("applied_amount").numFmt = "$#,##0.00";
  styleDataRows(matchSheet, 2, matchSheet.rowCount, {
    statusCol: 8,
    moneyCols: [2, 4],
  });

  return wb.xlsx.writeBuffer();
}

// ── PDF ───────────────────────────────────────────────────────────────────────

const PAGE_MARGIN = 40;

// Table column spec: { label, width, align, money?, statusColor? }
function buildColumns(defs) {
  return defs;
}

// Column widths in each table definition are relative proportions, not exact
// points — they rarely add up to the full printable width, which made tables
// hug the left margin with dead space on the right instead of using the whole
// page. This rescales them proportionally so they always span exactly from
// margin to margin (which also centers the table, since both margins match).
function scaleColumnsToWidth(columns, targetWidth) {
  const total = columns.reduce((sum, c) => sum + c.width, 0);
  const factor = targetWidth / total;
  return columns.map((c) => ({ ...c, width: c.width * factor }));
}

function drawTableHeader(doc, title, columns, startY) {
  const marginLeft = PAGE_MARGIN;
  doc.x = marginLeft;
  doc.y = startY;

  // Section title bar
  const barWidth = doc.page.width - marginLeft * 2;
  doc.rect(marginLeft, doc.y, barWidth, 20).fill(COLORS.brandRGB);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(title, marginLeft + 6, doc.y + 5, { width: barWidth - 12 });
  doc.y += 20;

  // Column header row
  const headerY = doc.y;
  doc.rect(marginLeft, headerY, barWidth, 18).fill(COLORS.headerBg);
  let x = marginLeft;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#374151");
  for (const col of columns) {
    doc.text(col.label, x + 4, headerY + 5, {
      width: col.width - 8,
      align: col.align ?? "left",
    });
    x += col.width;
  }
  doc.fillColor("#000000");
  return headerY + 18;
}

function drawTable(doc, title, rawColumns, rows) {
  const marginLeft = PAGE_MARGIN;
  const rowHeight = 15;
  const bottomLimit = doc.page.height - PAGE_MARGIN;
  const contentWidth = doc.page.width - marginLeft * 2;
  const columns = scaleColumnsToWidth(rawColumns, contentWidth);

  if (doc.y > doc.page.height - 120) doc.addPage();
  let y = drawTableHeader(doc, title, columns, doc.y + 8);

  if (rows.length === 0) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor(COLORS.textMuted)
      .text("No records.", marginLeft + 4, y + 4);
    doc.fillColor("#000000");
    doc.x = marginLeft;
    doc.y = y + rowHeight + 6;
    return;
  }

  rows.forEach((row, idx) => {
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawTableHeader(doc, `${title} (cont.)`, columns, PAGE_MARGIN);
    }

    if (idx % 2 === 1) {
      doc
        .rect(
          marginLeft,
          y,
          columns.reduce((s, c) => s + c.width, 0),
          rowHeight,
        )
        .fill(COLORS.rowAlt);
    }

    let x = marginLeft;
    doc.font("Helvetica").fontSize(8);
    row.forEach((cell, i) => {
      const col = columns[i];
      const isStatusCol = col.statusColor === true;
      doc.fillColor(isStatusCol ? statusColor(cell) : "#111827");
      if (isStatusCol) doc.font("Helvetica-Bold");
      doc.text(String(cell), x + 4, y + 4, {
        width: col.width - 8,
        align: col.align ?? "left",
        ellipsis: true,
      });
      if (isStatusCol) doc.font("Helvetica");
      x += col.width;
    });
    doc.fillColor("#000000");

    // row separator
    doc
      .moveTo(marginLeft, y + rowHeight)
      .lineTo(
        marginLeft + columns.reduce((s, c) => s + c.width, 0),
        y + rowHeight,
      )
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .stroke();

    y += rowHeight;
  });

  doc.x = marginLeft;
  doc.y = y + 10;
}

function addFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Drawing inside the bottom margin makes pdfkit think the page content
    // overflowed and silently inserts a new blank page to "fit" it — even
    // though we're using an explicit y and never asked for a page break.
    // Zeroing the bottom margin for this one call stops that from happening.
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 28;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(COLORS.textMuted)
      .text(`Page ${i + 1} of ${range.count}`, PAGE_MARGIN, bottom, {
        width: doc.page.width - PAGE_MARGIN * 2,
        align: "center",
      });
    doc.page.margins.bottom = originalBottomMargin;
    doc.fillColor("#000000");
  }
}

export function buildClientExportPdf(data) {
  const { client, stats } = data;
  const invoices = excludeZeroAmount(data.invoices, "total_amount");
  const payments = excludeZeroAmount(data.payments, "amount");
  const allocations = excludeZeroAmount(data.allocations, "amount");
  const doc = new PDFDocument({
    margin: PAGE_MARGIN,
    size: "A4",
    bufferPages: true,
  });

  const marginLeft = PAGE_MARGIN;
  const contentWidth = doc.page.width - marginLeft * 2;

  // ── Header band ──
  doc.rect(0, 0, doc.page.width, 70).fill(COLORS.brandRGB);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text("Monkey Cleaning", marginLeft, 20);
  doc
    .font("Helvetica")
    .fontSize(10)
    .text("Client Billing Report", marginLeft, 42);
  doc.fillColor("#000000");
  doc.y = 90;
  doc.x = marginLeft;

  // ── Client info card ──
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#111827")
    .text(clientDisplayName(client), marginLeft, doc.y);
  doc.font("Helvetica").fontSize(9).fillColor(COLORS.textMuted);
  if (client.email) doc.text(client.email, marginLeft, doc.y + 2);
  if (client.mobile ?? client.phone)
    doc.text(client.mobile ?? client.phone, marginLeft);
  doc.fillColor("#000000");
  doc.moveDown(1);

  // ── Summary cards ──
  const cardY = doc.y;
  const cardW = contentWidth / 3 - 8;
  const cards = [
    {
      label: "Total billed",
      value: `$${stats.totalBilled.toFixed(2)}`,
      color: "#111827",
    },
    {
      label: "Total paid",
      value: `$${stats.totalPaid.toFixed(2)}`,
      color: COLORS.green,
    },
    {
      label: "Balance",
      value: `$${stats.balance.toFixed(2)}`,
      color: stats.balance > 0 ? COLORS.red : COLORS.green,
    },
  ];
  cards.forEach((card, i) => {
    const x = marginLeft + i * (cardW + 12);
    doc
      .roundedRect(x, cardY, cardW, 46, 4)
      .fillAndStroke(COLORS.headerBg, COLORS.border);
    doc
      .fillColor(COLORS.textMuted)
      .font("Helvetica")
      .fontSize(8)
      .text(card.label.toUpperCase(), x + 8, cardY + 8);
    doc
      .fillColor(card.color)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(card.value, x + 8, cardY + 22);
  });
  doc.fillColor("#000000");
  doc.x = marginLeft;
  doc.y = cardY + 58;

  if (stats.billingStatus) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(statusColor(stats.billingStatus))
      .text(`Billing status: ${stats.billingStatus}`, marginLeft, doc.y);
    doc.fillColor("#000000");
    doc.moveDown(1);
  }

  // ── Invoices ──
  drawTable(
    doc,
    "Invoices",
    buildColumns([
      { label: "Doc #", width: 55 },
      { label: "Issued", width: 65 },
      { label: "Due", width: 65 },
      { label: "Total", width: 70, align: "right" },
      { label: "Balance", width: 70, align: "right" },
      { label: "Status", width: 90, statusColor: true },
    ]),
    invoices.map((inv) => [
      inv.doc_number ?? "—",
      inv.issued_date ?? "—",
      inv.due_date ?? "—",
      `$${Number(inv.total_amount ?? 0).toFixed(2)}`,
      `$${Number(inv.balance ?? 0).toFixed(2)}`,
      inv.status,
    ]),
  );

  // ── Payments ──
  drawTable(
    doc,
    "Payments",
    buildColumns([
      { label: "Date", width: 90 },
      { label: "Amount", width: 80, align: "right" },
      { label: "Method", width: 150 },
      { label: "Status", width: 95, statusColor: true },
    ]),
    payments.map((p) => [
      p.payment_date,
      `$${Number(p.amount ?? 0).toFixed(2)}`,
      p.payment_method ?? "—",
      p.status,
    ]),
  );

  // ── Matching ── (Unicode "→" isn't in the standard Helvetica encoding and
  // renders as garbage — use the ASCII-safe "»" instead.)
  drawTable(
    doc,
    "Payment » Invoice Matching",
    buildColumns([
      { label: "Payment date", width: 70 },
      { label: "Payment amt", width: 65, align: "right" },
      { label: "Applied to", width: 65 },
      { label: "Applied amt", width: 65, align: "right" },
      { label: "Type", width: 95 },
      { label: "Matched by", width: 95 },
    ]),
    allocations.map((a) => [
      a.payment?.payment_date ?? "—",
      `$${Number(a.payment?.amount ?? 0).toFixed(2)}`,
      a.invoice?.doc_number ? `#${a.invoice.doc_number}` : "—",
      `$${Number(a.amount ?? 0).toFixed(2)}`,
      ALLOCATION_TYPE_LABEL[a.allocation_type] ?? a.allocation_type,
      SOURCE_LABEL[a.source] ?? a.source,
    ]),
  );

  addFooters(doc);
  doc.end();
  return doc;
}
