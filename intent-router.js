// intent-router.js — Five-Layer Pathway Classification
// Routes every merchant message to either data_entry or data_analytics pathway
// before any LLM or DB call is made.
//
// Layer 1 — Hard gates        (binary, always correct, always wins)
// Layer 2 — Intent scoring    (weighted signals, not if/else)
// Layer 3 — Session context   (history shifts the score)
// Layer 4 — Confidence check  (gap threshold decides if we act)
// Layer 5 — Fallback          (clarification + logging, never silent fail)

const { connect } = require('./db');
const trace = require('./trace');

// ─── Layer 1 Helpers ──────────────────────────────────────────────────────

/**
 * Dangerous commands that should never execute through chat.
 * Add new patterns here as you discover abuse vectors.
 */
function isDangerous(message) {
  return /\b(delete\s+all|reset\s+data|wipe|drop\s+all|clear\s+all|destroy|remove\s+all\s+data)\b/i.test(message);
}

/**
 * Greeting detector — routes to onboarding mode.
 * Matches common English, Hindi, and Hinglish greetings (short messages only).
 */
function isGreeting(message) {
  if (!message) return false;
  const trimmed = message.trim().toLowerCase().replace(/[?.!,;]/g, '');
  
  // Only trigger for short messages (<= 5 words) to avoid catching longer queries/statements
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 5 || words.length === 0) return false;

  // Regex pattern for common greetings (standalone or with very simple titles/names)
  const greetingPattern = /^(hi+|hello+|hey+|hii+|helo|yo|sup|what'?s\s*up|namaste|namaskar|ram\s*ram|pranam|salaam|assalam|vanakkam|hola|good\s*(morning|afternoon|evening|day)|shubh\s*prabhat|radhe\s*radhe|jai\s*jinendra|jai\s*mata\s*di)(\s+(bhai|yaar|sir|madam|ji|bot|shopbot|there|friend|bro|everyone))?$/i;

  return greetingPattern.test(trimmed);
}

/**
 * Help requests — route to onboarding mode (Gemini explains capabilities).
 */
function isHelpRequest(message) {
  return /\b(help|what can you do|how does this work|commands|options|features|guide|tutorial|what are you|who are you|what is this)\b/i.test(message);
}

/**
 * State-based confirmation gate — bare yes/no ONLY valid when there
 * is an active pending confirmation in the session. NOT keyword-based.
 * This prevents "ok sure let's talk" from triggering a store action.
 */
function isSystemConfirmation(message, session) {
  const bare = /^\s*(yes|no|ok|okay|sure|nope|nah|cancel|yeah|yep)\s*$/i;
  return bare.test(message) && session && session.pendingConfirmation === true;
}

// ─── Simplified Main Router ────────────────────────────────────────────

async function routePathway(message, session) {
  const tStart = Date.now();
  trace.logFunctionEntered('intent-router.js', 'routePathway', { message, sessionKeys: session ? Object.keys(session) : [] }, 'server.js');

  // ── Layer 1: Hard Gates (Always Win) ─────────────────────────────────
  
  if (isDangerous(message)) {
    const res = { route: 'safety_block', confident: true, method: 'hard_gate' };
    trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
    return res;
  }

  if (isGreeting(message)) {
    const res = { route: 'onboarding', confident: true, method: 'hard_gate' };
    trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
    return res;
  }

  if (isHelpRequest(message)) {
    const res = { route: 'onboarding', confident: true, method: 'hard_gate' };
    trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
    return res;
  }

  if (isSystemConfirmation(message, session)) {
    const route = (session && session.activeFlow) || 'data_entry';
    const res = { route: route, confident: true, method: 'hard_gate' };
    trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
    return res;
  }

  if (!session || !session.uploadDone) {
    const res = { route: 'data_entry', confident: true, method: 'hard_gate' };
    trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
    return res;
  }

  // ── Layer 2-5: Delegate to Gemini Classifier ─────────────────────────
  // Return "pass_to_classifier" signal — server.js will call classifyIntent()
  const res = { route: 'pass_to_classifier', confident: false, method: 'llm_delegation' };
  trace.logFunctionResult('intent-router.js', 'routePathway', res, Date.now() - tStart);
  return res;
}

// ─── Analytics Intent Resolution ──────────────────────────────────────────
// Once route === 'data_analytics', resolve which of the 15 intent IDs applies.
// Uses keyword bag scoring — same principle as Layer 2, but domain-specific.

// P1 FIX: Expanded signal words for accurate intent resolution.
// Key changes:
//  - total_revenue: removed bare 'total' (caused false positives on "total orders")
//    replaced with explicit multi-word phrases only.
//  - pending_orders: added 'orders', 'order count', 'how many orders' etc. so
//    "how many orders do I have" correctly resolves to pending_orders.
//  - low_stock: added 'items low', 'which items are low', 'low items'
const ANALYTICS_INTENT_SIGNALS = {
  top_products:     ['top product', 'top products', 'best product', 'best products', 'selling', 'popular', 'most sold', 'highest selling', 'best seller', 'top selling'],
  low_stock:        ['low stock', 'low inventory', 'running out', 'out of stock', 'reorder', 'finish', 'out of', 'items low', 'which items are low', 'low items', 'low on'],
  total_revenue:    ['revenue', 'earning', 'income', 'total revenue', 'total sales', 'total earning', 'total income', 'total collection', 'collection', 'how much made', 'how much earned', 'how much money'],
  pending_orders:   ['pending', 'deliver', 'shipped', 'dispatch', 'incomplete', 'not delivered', 'outstanding', 'orders', 'order count', 'how many orders', 'number of orders', 'my orders', 'all orders', 'total orders', 'order status'],
  dead_inventory:   ['dead', 'not selling', 'slow moving', 'sitting', 'no movement', 'moving slow', 'unsold', 'dead stock'],
  avg_order_value:  ['average', 'avg', 'per order', 'aov', 'order value', 'average order'],
  top_customers:    ['customer', 'buyer', 'who buys', 'loyal', 'top customer', 'who ordered most', 'best customer'],
  repeat_customers: ['repeat', 'returning', 'come back', 'returning buyer', 'loyal buyer'],
  best_day:         ['best day', 'peak day', 'which day', 'busiest day', 'most orders day', 'day most orders'],
  best_category:    ['category', 'which product type', 'segment', 'which category', 'product group', 'product type'],
  order_timing:     ['peak time', 'peak hour', 'morning orders', 'evening orders', 'what time orders', 'order time', 'when do orders'],
  growth_advice:    ['grow', 'improve', 'suggest', 'advice', 'what should', 'recommendation', 'tips', 'strategy'],
};

function resolveAnalyticsIntent(message) {
  const tStart = Date.now();
  trace.logFunctionEntered('intent-router.js', 'resolveAnalyticsIntent', { message }, 'server.js');
  
  const normalized = message
    .toLowerCase()
    .replace(/[?!.,'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const scores = {};
  for (const [intent, signals] of Object.entries(ANALYTICS_INTENT_SIGNALS)) {
    scores[intent] = signals.filter(s => normalized.includes(s)).length;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const resolved = sorted[0][1] > 0 ? sorted[0][0] : null;
  
  trace.logDataTransformation({ message }, { resolvedIntent: resolved });
  trace.logFunctionResult('intent-router.js', 'resolveAnalyticsIntent', resolved, Date.now() - tStart);
  return resolved;
}

// ─── Analytics Reply Formatter ────────────────────────────────────────────
// Converts raw MongoDB aggregation results into WhatsApp-friendly reply strings.
// Returns null for intents that need Gemini (e.g. growth_advice).

const { formatForWhatsApp } = require('./formatters/whatsapp-formatter');

// ─── Platform-neutral structured data builder ─────────────────────────────
// Returns { title: string, rows: [{ label, value }] } — NO markup, NO emojis.
// All data-computation logic is identical to the original formatAnalyticsReply.
// Returns null for intents that delegate to Gemini (growth_advice, unknown).

function buildAnalyticsData(intent_id, data) {
  switch (intent_id) {

    case 'top_products': {
      if (!data || data.length === 0)
        return { title: 'Top Products', rows: [], empty: true, emptyMessage: 'No product sales data yet. Upload your orders Excel to see top sellers!' };
      const rows = data.slice(0, 5).map((p, i) => ({
        label: `${i + 1}. ${p.name || p.product_name || 'Unknown'}`,
        value: `${p.totalSold || p.count || 0} sold`,
      }));
      return { title: 'Top Products', rows };
    }

    case 'low_stock': {
      if (!data || data.length === 0)
        return { title: 'Low Stock', rows: [], empty: true, emptyMessage: 'All items are above their reorder levels. Stock looks healthy!' };
      const rows = data.slice(0, 6).map(p => ({
        label: p.product_name || p.name,
        value: `${p.stock_quantity} left (reorder at ${p.reorder_level ?? '—'})`,
        warning: true,
      }));
      return { title: `Low Stock Alert (${data.length} items)`, rows };
    }

    case 'total_revenue': {
      const rev    = data?.total ?? 0;
      const orders = data?.count ?? 0;
      return {
        title: 'Total Revenue',
        rows: [
          { label: 'Revenue', value: `₹${rev.toFixed(2)}` },
          { label: 'Orders',  value: String(orders) },
        ],
      };
    }

    case 'pending_orders': {
      if (!data || data.length === 0)
        return { title: 'Pending Orders', rows: [], empty: true, emptyMessage: 'No pending orders right now — all caught up!' };
      const rows = data.slice(0, 3).map(o => ({
        label: o.order_id ? `#${o.order_id}` : 'Order',
        value: `${o.customer_name || 'Customer'} (${o.status || 'pending'})`,
      }));
      return { title: `Pending Orders: ${data.length}`, rows, totalCount: data.length };
    }

    case 'dead_inventory': {
      if (!data || data.length === 0)
        return { title: 'Dead Inventory', rows: [], empty: true, emptyMessage: 'All stocked products have at least one sale. No dead inventory!' };
      const rows = data.slice(0, 5).map(p => ({
        label: p.product_name || p.name,
        value: `${p.stock_quantity} in stock, 0 orders`,
      }));
      return { title: `Dead Inventory (${data.length} items not selling)`, rows };
    }

    case 'avg_order_value': {
      const avg   = data?.avg   ?? 0;
      const count = data?.count ?? 0;
      return {
        title: 'Average Order Value',
        rows: [
          { label: 'Average Order Value', value: `₹${avg.toFixed(2)}` },
          { label: 'Orders',              value: String(count) },
        ],
      };
    }

    case 'top_customers': {
      if (!data || data.length === 0)
        return { title: 'Top Customers', rows: [], empty: true, emptyMessage: 'No customer order data yet. Upload your orders Excel to see top buyers!' };
      const rows = data.slice(0, 5).map((c, i) => ({
        label: `${i + 1}. ${c.customer_name || 'Customer'}`,
        value: `${c.orderCount} orders · ₹${(c.totalSpent || 0).toFixed(2)}`,
      }));
      return { title: 'Top Customers', rows };
    }

    case 'repeat_customers': {
      const count = data?.repeatCount ?? 0;
      const pct   = data?.percentage  ?? 0;
      if (count === 0)
        return { title: 'Repeat Customers', rows: [], empty: true, emptyMessage: 'No repeat customers yet. Keep selling — they will come back!' };
      return {
        title: 'Repeat Customers',
        rows: [
          { label: 'Repeat Buyers',      value: String(count) },
          { label: 'Of All Customers',   value: `${pct.toFixed(1)}%` },
        ],
      };
    }

    case 'best_day': {
      if (!data || data.length === 0)
        return { title: 'Best Sales Day', rows: [], empty: true, emptyMessage: 'Not enough order history yet to identify peak days.' };
      const top  = data[0];
      const rows = [
        { label: top._id, value: `${top.count} orders | ₹${(top.revenue || 0).toFixed(2)}`, isTop: true },
        ...data.slice(1, 3).map(d => ({ label: d._id, value: `${d.count} orders` })),
      ];
      return { title: 'Best Sales Day', rows };
    }

    case 'best_category': {
      if (!data || data.length === 0)
        return { title: 'Top Categories', rows: [], empty: true, emptyMessage: 'No category data yet. Make sure your products Excel has a Category column.' };
      const rows = data.slice(0, 5).map((c, i) => ({
        label: `${i + 1}. ${c._id || 'Uncategorized'}`,
        value: `${c.count} products`,
      }));
      return { title: 'Top Categories', rows };
    }

    case 'order_timing': {
      if (!data || data.length === 0)
        return { title: 'Peak Order Hour', rows: [], empty: true, emptyMessage: 'Not enough order history for timing analysis yet.' };
      const top         = data[0];
      const hour        = top._id;
      const label       = hour < 12 ? 'AM' : 'PM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return {
        title: 'Peak Order Hour',
        rows: [
          { label: `${displayHour}${label}`, value: `${top.count} orders usually come in at this time` },
        ],
      };
    }

    case 'growth_advice':
      // Intentionally returns null — server will fall through to Gemini
      // with data context so it can give personalized suggestions
      return null;

    default:
      return null;
  }
}

// ─── Compatibility wrapper ────────────────────────────────────────────────
// Keeps the public API identical for every existing caller (meta-whatsapp.js,
// server.js). Internally calls buildAnalyticsData() → formatForWhatsApp().
// The string returned is byte-for-byte identical to the old implementation.

function formatAnalyticsReply(intent_id, data) {
  const structured = buildAnalyticsData(intent_id, data);
  return formatForWhatsApp(intent_id, structured);
}

module.exports = {
  routePathway,
  resolveAnalyticsIntent,
  formatAnalyticsReply,
  buildAnalyticsData,
  // Exported for unit testing
  isDangerous,
  isGreeting,
  isHelpRequest,
  isSystemConfirmation,
};
