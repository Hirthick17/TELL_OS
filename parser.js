// parser.js - Excel parsing for dataset-first storage
// The parser reads workbook reality: sheets, headers, rows, samples. It does
// not coerce rows into products/orders/inventory/payments.

const XLSX = require('xlsx');
const {
  detectSheetColumns,
  detectConcepts,
  profileColumns,
  detectSheetType,
  typeFromSheetName,
} = require('./column-detector');

const BATCH_SIZE = 200;

function readHeaderRow(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellAddr = XLSX.utils.encode_cell({ r: range.s.r, c: col });
    const cell = sheet[cellAddr];
    if (cell && cell.v !== undefined && cell.v !== '') headers.push(String(cell.v));
  }
  return { headers, rowCount: Math.max(0, range.e.r - range.s.r) };
}

function detectSheetsAndColumns(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', sheetStubs: true });
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const { headers, rowCount } = readHeaderRow(sheet);
    if (headers.length === 0) continue;

    const detection = detectSheetColumns(headers);
    const detectedConcepts = detectConcepts([sheetName, ...headers]);

    const inferredType = typeFromSheetName(sheetName) || detectSheetType(detection.columnMap).type;
    const finalType = (inferredType && inferredType !== 'unknown') ? inferredType : 'dataset';

    sheets.push({
      sheetName,
      type: finalType,
      headers,
      columns: headers,
      rowCount,
      detectedConcepts,
      columnMap: detection.columnMap,
      confidences: detection.confidences,
      unmatchedHeaders: detection.unmatchedHeaders,
      needsConfirmation: false,
    });
  }

  return {
    sheets,
    totalRows: sheets.reduce((sum, s) => sum + s.rowCount, 0),
    columns: [...new Set(sheets.flatMap(s => s.headers))],
    detectedConcepts: [...new Set(sheets.flatMap(s => s.detectedConcepts || []))],
    needsConfirmation: false,
  };
}

async function streamSheet(buffer, sheetName, onBatch) {
  const workbook = XLSX.read(buffer, { type: 'buffer', dense: true });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  const allRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  let batchIndex = 0;
  for (let offset = 0; offset < allRows.length; offset += BATCH_SIZE) {
    const batch = allRows.slice(offset, offset + BATCH_SIZE);
    await onBatch(batch, batchIndex++, offset + 1);
  }

  return { totalRows: allRows.length, batches: batchIndex };
}

function extractSamples(rows, columnMap, n = 3) {
  const samples = {};
  for (const [field, originalHeader] of Object.entries(columnMap || {})) {
    samples[field] = rows
      .slice(0, n)
      .map(r => r[originalHeader])
      .filter(v => v !== '' && v !== null && v !== undefined);
  }
  return samples;
}

function buildSheetMetadata(sheetPlan, sampleRows = []) {
  return {
    sheetName: sheetPlan.sheetName,
    rowCount: sheetPlan.rowCount,
    columns: sheetPlan.headers,
    detectedConcepts: sheetPlan.detectedConcepts || [],
    columnProfiles: profileColumns(sheetPlan.headers, sampleRows),
    semanticHints: {
      columnMap: sheetPlan.columnMap || {},
      confidences: sheetPlan.confidences || {},
      unmatchedHeaders: sheetPlan.unmatchedHeaders || [],
    },
  };
}

function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const plan = detectSheetsAndColumns(buffer);
  const result = {
    products: [],
    orders: [],
    inventory: [],
    payments: [],
    unknown: [],
    sheetSummary: [],
  };

  for (const sheetPlan of plan.sheets) {
    const sheet = workbook.Sheets[sheetPlan.sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    result.unknown.push(...rows);
    result.sheetSummary.push({
      sheetName: sheetPlan.sheetName,
      type: 'dataset',
      rowCount: rows.length,
      headers: sheetPlan.headers,
      detectedConcepts: sheetPlan.detectedConcepts,
      columnMap: sheetPlan.columnMap,
      confidences: sheetPlan.confidences,
      unmatchedHeaders: sheetPlan.unmatchedHeaders,
    });
  }

  return result;
}

module.exports = {
  detectSheetsAndColumns,
  streamSheet,
  extractSamples,
  buildSheetMetadata,
  parseExcel,
};
