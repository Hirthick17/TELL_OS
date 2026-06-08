// column-detector.js — Confidence-scored semantic column detection
// Three-pass strategy: exact match → contains match → fuse.js fuzzy
// Each matched column carries a confidence score [0.0 – 1.0]

let Fuse;
try {
  // Try npm-installed package first
  Fuse = require('fuse.js');
} catch (_) {
  try {
    // Fallback to local vendor copy (vendor/fuse.js)
    Fuse = require('./vendor/fuse.js');
  } catch (__) {
    console.warn('⚠️  fuse.js not found — Pass 3 fuzzy matching disabled. Run: npm install fuse.js');
    Fuse = null;
  }
}

// ─── Confidence thresholds ────────────────────────────────────────────────
const CONFIDENCE_EXACT    = 1.0;
const CONFIDENCE_CONTAINS = 0.8;
const CONFIDENCE_MIN      = 0.7;   // minimum fuse.js score to accept a match

// ─── Semantic field synonym dictionary ───────────────────────────────────
// Each key is the canonical semantic field name.
// Each value is an ordered list of known aliases, most specific first.
const SYNONYMS = {
  // ── Products ─────────────────────────────────────────────────────────
  product_name: [
    'product name', 'item name', 'item desc', 'product description',
    'name', 'item', 'product', 'description', 'desc', 'title',
    'particulars', 'goods', 'article', 'product title',
  ],
  price: [
    'selling price', 'unit price', 'sale price', 'retail price',
    'price', 'mrp', 'rate', 'cost', 'sp', 'value',
    'amount',   // lower priority — also matches orders
  ],
  category: [
    'category', 'product category', 'item category', 'type',
    'department', 'segment', 'product type', 'cat',
  ],
  brand: [
    'brand', 'brand name', 'manufacturer', 'make', 'label', 'vendor',
  ],
  sku: [
    'sku', 'item code', 'product code', 'article no', 'part no',
    'barcode', 'upc', 'isbn', 'code', 'ref',
  ],
  description: [
    'description', 'details', 'product details', 'spec', 'specification',
    'notes', 'remarks', 'info',
  ],
  unit: [
    'unit', 'uom', 'unit of measure', 'pack size', 'pack', 'measurement',
  ],

  // ── Stock / Inventory ─────────────────────────────────────────────────
  stock: [
    'stock quantity', 'available quantity', 'qty on hand',
    'stock', 'qty', 'quantity', 'available', 'avl', 'avail',
    'inventory', 'units', 'count', 'balance', 'on hand',
    'closing stock', 'current stock',
  ],
  reorder_level: [
    'reorder level', 'reorder point', 'min stock', 'minimum quantity',
    'reorder', 'min qty', 'safety stock', 'minimum',
  ],
  warehouse: [
    'warehouse', 'location', 'shelf', 'bin', 'rack', 'store',
    'storage', 'godown',
  ],

  // ── Orders ────────────────────────────────────────────────────────────
  order_id: [
    'order id', 'order no', 'order number', 'order ref',
    'order', 'id', 'ref no', 'reference', 'invoice no', 'invoice number',
  ],
  customer: [
    'customer name', 'buyer name', 'client name',
    'customer', 'buyer', 'client', 'name',
    'ship to', 'bill to',
  ],
  customer_email: [
    'customer email', 'buyer email', 'email address',
    'email', 'e-mail', 'mail',
  ],
  customer_phone: [
    'customer phone', 'buyer phone', 'mobile', 'phone number',
    'phone', 'contact', 'mobile no', 'cell',
  ],
  order_quantity: [
    'order quantity', 'units ordered', 'qty ordered',
    'qty', 'quantity', 'units', 'count',
  ],
  order_amount: [
    'order amount', 'order total', 'total amount', 'sale amount',
    'amount', 'total', 'value', 'order value',
  ],
  order_status: [
    'order status', 'delivery status', 'shipment status',
    'status', 'state', 'fulfillment status',
  ],
  order_date: [
    'order date', 'order placed', 'purchase date', 'sale date',
    'date', 'ordered', 'placed on', 'booked on', 'created',
  ],

  // ── Payments ──────────────────────────────────────────────────────────
  payment_id: [
    'payment id', 'transaction id', 'txn id', 'payment ref',
    'payment no', 'ref no', 'receipt no', 'utr',
  ],
  payment_method: [
    'payment method', 'payment mode', 'mode of payment',
    'method', 'mode', 'gateway', 'paid via', 'pay mode',
  ],
  payment_status: [
    'payment status', 'txn status',
    'status', 'payment state',
  ],
  payment_date: [
    'payment date', 'paid on', 'transaction date', 'txn date',
    'date', 'paid date',
  ],
  payment_amount: [
    'payment amount', 'paid amount', 'transaction amount',
    'amount', 'total', 'value',
  ],
};

// ─── Which semantic fields signal which sheet type ─────────────────────────
// Used by detectSheetType() to score sheets from their columnMap
const SHEET_TYPE_SIGNALS = {
  products: {
    strong: ['product_name', 'price', 'category', 'brand'],
    weak:   ['sku', 'description', 'unit'],
  },
  inventory: {
    strong: ['stock', 'reorder_level', 'warehouse'],
    weak:   ['sku', 'product_name'],
  },
  orders: {
    strong: ['order_id', 'customer', 'order_status', 'order_date'],
    weak:   ['order_quantity', 'order_amount', 'customer_email'],
  },
  payments: {
    strong: ['payment_id', 'payment_method', 'payment_status'],
    weak:   ['payment_date', 'payment_amount'],
  },
};

// ─── Utility: normalize a header string ──────────────────────────────────
// lowercase → strip all punctuation + special chars → collapse whitespace
function normalizeHeader(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')   // punctuation → space
    .replace(/\s+/g, ' ')        // collapse multiple spaces
    .trim();
}

// ─── Build a Fuse instance for a list of aliases ──────────────────────────
function buildFuse(aliases) {
  if (!Fuse) return null;
  return new Fuse(aliases, {
    includeScore:    true,
    threshold:       1 - CONFIDENCE_MIN,   // fuse threshold is inverted (0 = perfect)
    distance:        100,
    minMatchCharLength: 2,
  });
}

// Pre-build one Fuse index per semantic field for performance
const FUSE_INDEXES = {};
for (const [field, aliases] of Object.entries(SYNONYMS)) {
  FUSE_INDEXES[field] = buildFuse(aliases);
}

// ─── Single-field detection: run 3 passes on one header ──────────────────
/**
 * @param {string} rawHeader  - original column header from Excel
 * @param {string} field      - semantic field name (key in SYNONYMS)
 * @returns {{ matched: boolean, confidence: number }}
 */
function detectField(rawHeader, field) {
  const normalized = normalizeHeader(rawHeader);
  const aliases    = SYNONYMS[field];

  // ── Pass 1: Exact match ─────────────────────────────────────────────
  for (const alias of aliases) {
    if (normalized === normalizeHeader(alias)) {
      return { matched: true, confidence: CONFIDENCE_EXACT };
    }
  }

  // ── Pass 2: Contains match ──────────────────────────────────────────
  for (const alias of aliases) {
    const normAlias = normalizeHeader(alias);
    if (normalized.includes(normAlias) || normAlias.includes(normalized)) {
      return { matched: true, confidence: CONFIDENCE_CONTAINS };
    }
  }

  // ── Pass 3: Fuse.js fuzzy match ─────────────────────────────────────
  const fuse = FUSE_INDEXES[field];
  if (fuse) {
    const results = fuse.search(normalized);
    if (results.length > 0) {
      const best = results[0];
      const confidence = 1 - best.score;   // fuse score: 0=perfect, 1=no match → invert
      if (confidence >= CONFIDENCE_MIN) {
        return { matched: true, confidence: parseFloat(confidence.toFixed(3)) };
      }
    }
  }

  return { matched: false, confidence: 0 };
}

// ─── Detect all semantic fields for one header ────────────────────────────
/**
 * Runs all fields against one header, returns the best matching field.
 * @param {string} rawHeader
 * @returns {{ field: string|null, confidence: number }}
 */
function detectBestField(rawHeader) {
  let bestField      = null;
  let bestConfidence = 0;

  for (const field of Object.keys(SYNONYMS)) {
    const result = detectField(rawHeader, field);
    if (result.matched && result.confidence > bestConfidence) {
      bestField      = field;
      bestConfidence = result.confidence;
    }
  }

  return { field: bestField, confidence: bestConfidence };
}

// ─── Main: detect all columns in a sheet ─────────────────────────────────
/**
 * @param {string[]} headers - raw column headers from Excel sheet
 * @returns {{
 *   columnMap: Object,        // semanticField → originalHeader
 *   confidences: Object,      // semanticField → confidence score
 *   unmatchedHeaders: string[], // headers with confidence < threshold
 *   needsConfirmation: boolean
 * }}
 */
function detectSheetColumns(headers) {
  const columnMap        = {};   // semanticField → originalHeader
  const confidences      = {};   // semanticField → confidence score
  const unmatchedHeaders = [];   // low-confidence headers for merchant confirmation

  for (const header of headers) {
    const { field, confidence } = detectBestField(header);

    if (field && confidence >= CONFIDENCE_MIN) {
      // If two headers map to the same field, keep the higher-confidence one
      if (!columnMap[field] || confidence > confidences[field]) {
        columnMap[field]   = header;
        confidences[field] = confidence;
      }
    } else {
      unmatchedHeaders.push(header);
    }
  }

  const needsConfirmation = unmatchedHeaders.length > 0;

  return { columnMap, confidences, unmatchedHeaders, needsConfirmation };
}

// ─── Infer sheet semantic type from its column map ───────────────────────
/**
 * @param {Object} columnMap  - from detectSheetColumns()
 * @returns {{ type: string, score: number }}
 */
function detectSheetType(columnMap) {
  const matchedFields = new Set(Object.keys(columnMap));
  const scores = {};

  for (const [type, signals] of Object.entries(SHEET_TYPE_SIGNALS)) {
    let score = 0;
    for (const f of signals.strong) if (matchedFields.has(f)) score += 3;
    for (const f of signals.weak)   if (matchedFields.has(f)) score += 1;
    scores[type] = score;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] === 0) return { type: 'unknown', score: 0 };
  return { type: best[0], score: best[1] };
}

// ─── Quick sheet-name hint ────────────────────────────────────────────────
// Override type detection if the sheet name itself is a clear signal
function typeFromSheetName(sheetName) {
  const sn = sheetName.toLowerCase();
  if (sn.includes('product'))                              return 'products';
  if (sn.includes('order'))                               return 'orders';
  if (sn.includes('inventory') || sn.includes('stock'))  return 'inventory';
  if (sn.includes('payment') || sn.includes('transaction')) return 'payments';
  return null;
}

// Dataset-first concept detection. These labels are metadata, not storage
// destinations. Rows always remain in dataset_records.data with original keys.
const CONCEPT_SIGNALS = {
  products: [
    'product', 'product id', 'product name', 'item', 'item name', 'sku',
    'category', 'brand', 'barcode',
  ],
  inventory: [
    'stock', 'closing stock', 'current stock', 'inventory', 'on hand',
    'reorder', 'reorder point', 'reorder level', 'warehouse',
  ],
  sales: [
    'sales', 'units sold', 'quantity sold', 'order', 'order id',
    'retail price', 'selling price', 'amount', 'revenue', 'total',
  ],
  suppliers: [
    'supplier', 'supplier name', 'vendor', 'manufacturer', 'brand',
  ],
  customers: [
    'customer', 'buyer', 'client', 'email', 'phone', 'mobile',
  ],
  payments: [
    'payment', 'transaction', 'paid', 'method', 'gateway', 'utr',
  ],
};

function detectConcepts(headers = []) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const concepts = [];

  for (const [concept, signals] of Object.entries(CONCEPT_SIGNALS)) {
    let score = 0;
    for (const signal of signals) {
      const normalizedSignal = normalizeHeader(signal);
      if (normalizedHeaders.some(h => h === normalizedSignal || h.includes(normalizedSignal) || normalizedSignal.includes(h))) {
        score += 1;
      }
    }
    if (score > 0) concepts.push({ concept, score });
  }

  return concepts
    .sort((a, b) => b.score - a.score)
    .map(c => c.concept);
}

function profileColumns(headers = [], sampleRows = []) {
  return headers.map(header => {
    const values = sampleRows
      .map(row => row?.[header])
      .filter(v => v !== '' && v !== null && v !== undefined);

    const numericCount = values.filter(v => {
      if (typeof v === 'number') return Number.isFinite(v);
      const clean = String(v).replace(/[\$,₹€£%]/g, '').replace(/,/g, '').trim();
      return clean.length > 0 && !isNaN(Number(clean));
    }).length;

    const type = values.length > 0 && numericCount / values.length >= 0.8
      ? 'number'
      : 'text';

    return {
      name: header,
      type,
      sampleValues: values.slice(0, 3),
      concepts: detectConcepts([header]),
    };
  });
}

module.exports = {
  SYNONYMS,
  CONCEPT_SIGNALS,
  CONFIDENCE_EXACT,
  CONFIDENCE_CONTAINS,
  CONFIDENCE_MIN,
  normalizeHeader,
  detectField,
  detectBestField,
  detectSheetColumns,
  detectSheetType,
  typeFromSheetName,
  detectConcepts,
  profileColumns,
};
