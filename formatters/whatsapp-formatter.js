// formatters/whatsapp-formatter.js
// WhatsApp-specific presentation layer.
// Takes the platform-neutral { title, rows } shape produced by
// buildAnalyticsData() in intent-router.js and turns it into the
// *bold* + emoji text that WhatsApp renders correctly.
//
// Output is byte-for-byte identical to the original formatAnalyticsReply()
// strings for every intent, so all existing callers need no changes.

'use strict';

/**
 * Formats a structured analytics data object into a WhatsApp-ready string.
 *
 * @param {string}      intent_id  - The analytics intent identifier.
 * @param {object|null} structured - Result from buildAnalyticsData(), or null.
 * @returns {string|null} WhatsApp-formatted reply string, or null for Gemini-
 *                        delegated intents (growth_advice, unknown).
 */
function formatForWhatsApp(intent_id, structured) {
  // null from buildAnalyticsData means Gemini handles this intent
  if (structured === null) return null;

  // ── Empty / no-data fast paths (one message per intent) ─────────────────
  if (structured.empty) {
    switch (intent_id) {
      case 'top_products':
        return `📦 ${structured.emptyMessage}`;
      case 'low_stock':
        return `✅ ${structured.emptyMessage}`;
      case 'pending_orders':
        return `✅ ${structured.emptyMessage}`;
      case 'dead_inventory':
        return `✅ ${structured.emptyMessage}`;
      case 'top_customers':
        return `👤 ${structured.emptyMessage}`;
      case 'repeat_customers':
        return `👤 ${structured.emptyMessage}`;
      case 'best_day':
        return `📅 ${structured.emptyMessage}`;
      case 'best_category':
        return `📂 ${structured.emptyMessage}`;
      case 'order_timing':
        return `⏰ ${structured.emptyMessage}`;
      default:
        return structured.emptyMessage || null;
    }
  }

  // ── Intent-specific WhatsApp formatting ──────────────────────────────────

  switch (intent_id) {

    case 'top_products': {
      const list = structured.rows
        .map(r => `${r.label} — ${r.value}`)
        .join('\n');
      return `📦 *Top Products:*\n${list}`;
    }

    case 'low_stock': {
      const list = structured.rows
        .map(r => `⚠️ ${r.label} — ${r.value}`)
        .join('\n');
      // title already contains the count: "Low Stock Alert (N items)"
      return `🔴 *${structured.title}:*\n${list}`;
    }

    case 'total_revenue': {
      const rev    = structured.rows.find(r => r.label === 'Revenue')?.value ?? '₹0.00';
      const orders = structured.rows.find(r => r.label === 'Orders')?.value  ?? '0';
      return `💰 *Total Revenue:* ${rev}\n🛒 From ${orders} orders`;
    }

    case 'pending_orders': {
      const totalCount = structured.totalCount ?? structured.rows.length;
      const preview = structured.rows
        .map(r => `• ${r.label} — ${r.value}`)
        .join('\n');
      const more = totalCount > 3 ? `\n…and ${totalCount - 3} more` : '';
      // title already contains the count: "Pending Orders: N"
      return `🛒 *${structured.title}*\n${preview}${more}`;
    }

    case 'dead_inventory': {
      const list = structured.rows
        .map(r => `• ${r.label} — ${r.value}`)
        .join('\n');
      // title already contains the count: "Dead Inventory (N items not selling)"
      return `💤 *${structured.title}:*\n${list}`;
    }

    case 'avg_order_value': {
      const avg    = structured.rows.find(r => r.label === 'Average Order Value')?.value ?? '₹0.00';
      const orders = structured.rows.find(r => r.label === 'Orders')?.value              ?? '0';
      return `📊 *Average Order Value:* ${avg}\n📦 Across ${orders} orders`;
    }

    case 'top_customers': {
      const list = structured.rows
        .map(r => `${r.label} — ${r.value}`)
        .join('\n');
      return `👑 *Top Customers:*\n${list}`;
    }

    case 'repeat_customers': {
      const count = structured.rows.find(r => r.label === 'Repeat Buyers')?.value    ?? '0';
      const pct   = structured.rows.find(r => r.label === 'Of All Customers')?.value ?? '0.0%';
      return `🔄 *Repeat Customers:* ${count} buyers\n📈 ${pct} of all your customers have ordered more than once`;
    }

    case 'best_day': {
      const topRow   = structured.rows.find(r => r.isTop);
      const restRows = structured.rows.filter(r => !r.isTop);
      const rest     = restRows.map(r => `• ${r.label} — ${r.value}`).join('\n');
      return (
        `📅 *Best Sales Day:* ${topRow.label}\n` +
        `🛒 ${topRow.value}\n` +
        (rest ? `\nRunner-ups:\n${rest}` : '')
      ).trim();
    }

    case 'best_category': {
      const list = structured.rows
        .map(r => `${r.label} — ${r.value}`)
        .join('\n');
      return `📂 *Top Categories:*\n${list}`;
    }

    case 'order_timing': {
      const row = structured.rows[0];
      return `⏰ *Peak Order Hour:* ${row.label}\n🛒 ${row.value}`;
    }

    default:
      return null;
  }
}

module.exports = { formatForWhatsApp };
