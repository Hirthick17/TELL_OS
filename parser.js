// parser.js - Excel auto-detection and data extraction
const XLSX = require('xlsx');

/**
 * Detects what type of data a sheet contains based on column headers.
 * Returns: 'products' | 'orders' | 'inventory' | 'payments' | 'unknown'
 */
function detectSheetType(headers) {
  const h = headers.map(x => String(x).toLowerCase().replace(/[\s_-]/g, ''));

  const scores = {
    products: 0,
    orders: 0,
    inventory: 0,
    payments: 0,
  };

  // Product signals
  if (h.some(x => x.includes('product') || x.includes('item') || x === 'name')) scores.products += 2;
  if (h.some(x => x.includes('price') || x.includes('unitprice') || x.includes('cost'))) scores.products += 2;
  if (h.some(x => x.includes('category') || x.includes('sku') || x.includes('brand'))) scores.products += 2;
  if (h.some(x => x.includes('description'))) scores.products += 1;

  // Order signals
  if (h.some(x => x.includes('orderid') || x.includes('orderno') || x === 'order')) scores.orders += 3;
  if (h.some(x => x.includes('customer') || x.includes('buyer'))) scores.orders += 2;
  if (h.some(x => x.includes('quantity') || x.includes('qty'))) scores.orders += 1;
  if (h.some(x => x.includes('status') && !x.includes('payment'))) scores.orders += 1;
  if (h.some(x => x.includes('orderdate') || x.includes('date') || x.includes('ordered'))) scores.orders += 1;

  // Inventory signals
  if (h.some(x => x.includes('stock') || x.includes('inventory') || x.includes('onhand'))) scores.inventory += 3;
  if (h.some(x => x.includes('reorder') || x.includes('reorderlevel'))) scores.inventory += 2;
  if (h.some(x => x.includes('warehouse') || x.includes('location') || x.includes('shelf'))) scores.inventory += 2;
  if (h.some(x => x.includes('sku'))) scores.inventory += 1;

  // Payment signals
  if (h.some(x => x.includes('paymentid') || x === 'payment' || x.includes('transactionid'))) scores.payments += 3;
  if (h.some(x => x.includes('paymentmethod') || x.includes('method') || x.includes('gateway'))) scores.payments += 2;
  if (h.some(x => x.includes('paymentstatus') || (x.includes('status') && x.includes('pay')))) scores.payments += 2;
  if (h.some(x => x.includes('paymentdate') || x.includes('paidon'))) scores.payments += 1;
  if (h.some(x => x.includes('amount') || x.includes('total'))) scores.payments += 1;

  // Pick highest score
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] === 0) return 'unknown';
  return best[0];
}

/**
 * Parse an Excel buffer and return categorized data.
 */
function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const result = {
    products: [],
    orders: [],
    inventory: [],
    payments: [],
    unknown: [],
    sheetSummary: [],
  };

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) continue;

    const headers = Object.keys(rows[0]);
    
    // Also check sheet name for hints
    const sn = sheetName.toLowerCase();
    let type;
    if (sn.includes('product')) type = 'products';
    else if (sn.includes('order')) type = 'orders';
    else if (sn.includes('inventory') || sn.includes('stock')) type = 'inventory';
    else if (sn.includes('payment') || sn.includes('transaction')) type = 'payments';
    else type = detectSheetType(headers);

    result[type] = result[type] || [];
    result[type].push(...rows);

    result.sheetSummary.push({
      sheetName,
      type,
      rowCount: rows.length,
      headers,
    });
  }

  return result;
}

module.exports = { parseExcel, detectSheetType };
