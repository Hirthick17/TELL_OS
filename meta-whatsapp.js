// meta-whatsapp.js — Official Meta WhatsApp Cloud API integration
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// LLM logic and session store are shared via llm.js and sessions.js

require('dotenv').config();
const axios                  = require('axios');
const path                   = require('path');
const { parseExcel }         = require('./parser');
const db                     = require('./db');
const { chat }               = require('./llm');
const { getSessionByPhone, persistSession } = require('./sessions'); // ← phone-keyed, MongoDB-backed

// ─── Config ───────────────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN    || 'shopbot_verify_2024';
const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const PUBLIC_URL      = process.env.PUBLIC_URL || 'http://localhost:3000';
const API_VER         = 'v25.0';  // ← keep in sync with Meta dashboard
const META_API_URL    = `https://graph.facebook.com/${API_VER}/${PHONE_NUMBER_ID}/messages`;

// ─── Send a WhatsApp message ──────────────────────────────────────────────
async function sendMessage(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ META_ACCESS_TOKEN or META_PHONE_NUMBER_ID missing in .env');
    return;
  }
  try {
    await axios.post(META_API_URL,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📤 → ${to}: ${text.substring(0, 60).replace(/\n/g,' ')}…`);
  } catch (err) {
    console.error('❌ Send failed:', JSON.stringify(err.response?.data || err.message));
  }
}

// ─── Send a WhatsApp template message (use to initiate conversations) ───────
// Templates must be approved in Meta Business Manager first.
// templateName: e.g. 'jaspers_market_plain_text_v1'
// langCode:     e.g. 'en_US'
async function sendTemplate(to, templateName, langCode = 'en_US', components = []) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ META_ACCESS_TOKEN or META_PHONE_NUMBER_ID missing in .env');
    return;
  }
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode },
      ...(components.length > 0 ? { components } : {}),
    },
  };
  try {
    const { data } = await axios.post(META_API_URL, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    });
    console.log(`📤 Template "${templateName}" → ${to} | msgId: ${data.messages?.[0]?.id}`);
    return data;
  } catch (err) {
    console.error('❌ Template send failed:', JSON.stringify(err.response?.data || err.message));
    throw err;
  }
}

// ─── Download media file from Meta ───────────────────────────────────────
async function downloadMedia(mediaId) {
  try {
    const { data: meta } = await axios.get(
      `https://graph.facebook.com/${API_VER}/${mediaId}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    const { data } = await axios.get(meta.url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(data);
  } catch (err) {
    console.error('❌ Media download failed:', err.response?.data || err.message);
    return null;
  }
}

// ─── Handle Excel file attachment ────────────────────────────────────────
async function handleFileMessage(waId, mediaId, filename) {
  const session = await getSessionByPhone(waId);
  await sendMessage(waId, '📥 Got your file! Scanning it now...');

  const buffer = await downloadMedia(mediaId);
  if (!buffer) {
    await sendMessage(waId, '❌ Could not download the file. Please try again.');
    return;
  }

  const ext = path.extname(filename || '').toLowerCase() || '.xlsx';
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    await sendMessage(waId, `❌ Please send an Excel (.xlsx or .csv) file, not ${ext}.`);
    return;
  }

  try {
    const parsed = parseExcel(buffer);
    const lines  = [];

    if (parsed.products.length  > 0) lines.push(`📦 *${parsed.products.length} Products* found`);
    if (parsed.orders.length    > 0) lines.push(`🛒 *${parsed.orders.length} Orders* found`);
    if (parsed.inventory.length > 0) lines.push(`🏪 *${parsed.inventory.length} Inventory items* found`);
    if (parsed.payments.length  > 0) lines.push(`💳 *${parsed.payments.length} Payment records* found`);

    if (lines.length === 0) {
      await sendMessage(waId,
        `❌ No readable data in "${filename}".\n\n` +
        `Column labels needed:\n• Product Name, Price, SKU\n• Order ID, Customer Name\n• Stock, Reorder Level\n\nSend a corrected file!`
      );
      return;
    }

    session.pendingPreview = { products: parsed.products, orders: parsed.orders,
      inventory: parsed.inventory, payments: parsed.payments, fileName: filename };
    session.awaitingUpload = false;
    persistSession(session);

    const sheetInfo = parsed.sheetSummary
      .map(s => `  • ${s.sheetName} → ${s.type} (${s.rowCount} rows)`)
      .join('\n');

    const reply =
      `✅ Scanned *${filename}*\n\n` +
      `Found:\n${lines.join('\n')}\n\n` +
      `📋 Sheets:\n${sheetInfo}\n\n` +
      `💾 *Should I store this in your account?*\nReply *Yes* to save, *No* to cancel.`;

    session.history.push({ role: 'user',  parts: [{ text: `[Sent Excel: ${filename}]` }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    await sendMessage(waId, reply);

  } catch (err) {
    console.error('Excel parse error:', err.message);
    await sendMessage(waId, `❌ Error reading file: ${err.message}`);
  }
}

// ─── Handle text message ──────────────────────────────────────────────────
async function handleTextMessage(waId, text) {
  const session = await getSessionByPhone(waId);
  const lower   = text.toLowerCase();

  const YES = ['yes', 'store', 'save', 'confirm', 'proceed', 'sure', 'ok', 'done', 'yeah', 'yep', 'ha', 'haan'];
  const NO  = ['no', 'cancel', 'nope', 'nahi', 'nah', 'stop'];

  // ── User confirming pending data storage ──────────────────────────────
  if (session.pendingPreview) {
    if (YES.some(k => lower.includes(k))) {
      await sendMessage(waId, '⏳ Saving your data...');
      try {
        const p = session.pendingPreview;
        if (p.products.length  > 0) await db.insertProducts(session.sessionId, p.products);
        if (p.orders.length    > 0) await db.insertOrders(session.sessionId, p.orders);
        if (p.inventory.length > 0) await db.insertInventory(session.sessionId, p.inventory);
        if (p.payments.length  > 0) await db.insertPayments(session.sessionId, p.payments);

        const stats      = await db.getStats(session.sessionId);
        const dashUrl    = `${PUBLIC_URL}/dashboard/${session.sessionId}`;
        session.pendingPreview = null;
        session.uploadDone     = true;
        persistSession(session);

        const reply =
          `🎉 All saved!\n\n📊 *Live Dashboard:*\n${dashUrl}\n\n` +
          `📦 ${stats.products} products  🛒 ${stats.orders} orders\n` +
          `🏪 ${stats.inventory} inventory  💳 ${stats.payments} payments\n\n` +
          `Dashboard auto-refreshes every 10s! 🚀`;

        session.history.push({ role: 'model', parts: [{ text: reply }] });
        await sendMessage(waId, reply);
      } catch (err) {
        await sendMessage(waId, `❌ Error saving: ${err.message}`);
      }
      return;
    }

    if (NO.some(k => lower.includes(k))) {
      session.pendingPreview = null;
      const reply = `No problem! 😊 Upload a different file or let me know how I can help.`;
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      await sendMessage(waId, reply);
      return;
    }
  }

  // ── Service activation ────────────────────────────────────────────────
  if (session.uploadDone && YES.some(k => lower.includes(k))) {
    session.confirmed = true;
    await db.confirmSession(session.sessionId).catch(() => {});
  }

  // ── Regular Gemini chat ───────────────────────────────────────────────
  let contextNote = '';
  if (session.uploadDone) {
    contextNote = `[Context: Data already stored. Dashboard: ${PUBLIC_URL}/dashboard/${session.sessionId}]`;
  } else if (session.awaitingUpload) {
    contextNote = '[Context: Already asked user to send Excel file. Remind them.]';
  }

  try {
    const reply = await chat(text, session.history, contextNote);   // ← uses shared llm.js
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    if (/upload|excel|xlsx|file|attach|spreadsheet|send/i.test(reply)) {
      session.awaitingUpload = true;
    }
    await sendMessage(waId, reply);
  } catch (err) {
    console.error('Meta LLM error:', err.message);
    await sendMessage(waId, `❌ ${err.message}`);
  }
}

// ─── Webhook handlers (registered in server.js) ──────────────────────────

// GET /webhook — Meta verification challenge
function handleVerification(req, res) {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  console.log(`📬 Webhook verify: mode=${mode}, token_ok=${token === VERIFY_TOKEN}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Verification failed — check META_VERIFY_TOKEN in .env');
    res.sendStatus(403);
  }
}

// POST /webhook — Incoming WhatsApp messages from Meta
async function handleWebhook(req, res) {
  const body = req.body;
  res.sendStatus(200); // Always 200 immediately — Meta retries if you don't

  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      const msgs = change.value?.messages;
      if (!msgs) continue;

      for (const msg of msgs) {
        const waId = msg.from;
        console.log(`\n📨 ${waId} [${msg.type}]`);

        try {
          if (msg.type === 'text') {
            await handleTextMessage(waId, msg.text?.body?.trim());
          } else if (msg.type === 'document') {
            await handleFileMessage(waId, msg.document?.id, msg.document?.filename);
          } else if (msg.type === 'image') {
            await sendMessage(waId, `📸 Got your image! Send an Excel file (.xlsx) to store your business data.`);
          } else {
            await sendMessage(waId, `👋 Send a text message or an Excel file (.xlsx) to get started!`);
          }
        } catch (err) {
          console.error('Webhook handler error:', err.message);
        }
      }
    }
  }
}

module.exports = { handleVerification, handleWebhook, sendMessage, sendTemplate };
