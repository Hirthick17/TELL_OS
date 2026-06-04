// whatsapp.js - Real WhatsApp via whatsapp-web.js (QR scan)
// LLM logic and session store shared via llm.js and sessions.js

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode            = require('qrcode-terminal');
const path              = require('path');
const fs                = require('fs');
const { parseExcel }    = require('./parser');
const db                = require('./db');
const { chat }          = require('./llm');       // ← shared Gemini logic
const { getSession }    = require('./sessions');  // ← shared session store

const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ─── Handle incoming text message ──────────────────────────────────────────
async function handleTextMessage(client, msg, session, phoneNumber) {
  const text = msg.body.trim();

  // Check if user is confirming data storage
  const confirmKeywords = ['yes', 'store', 'save', 'confirm', 'proceed', 'sure', 'ok', 'done', 'yeah', 'ha', 'haa'];

  if (session.pendingPreview && confirmKeywords.some(k => text.toLowerCase().includes(k))) {
    // Store the pending data
    const p = session.pendingPreview;
    try {
      await client.sendMessage(msg.from, '⏳ Saving your data...');
      if (p.products.length > 0) await db.insertProducts(session.sessionId, p.products);
      if (p.orders.length > 0) await db.insertOrders(session.sessionId, p.orders);
      if (p.inventory.length > 0) await db.insertInventory(session.sessionId, p.inventory);
      if (p.payments.length > 0) await db.insertPayments(session.sessionId, p.payments);

      const stats = await db.getStats(session.sessionId);
      const dashboardUrl = `${PUBLIC_URL}/dashboard/${session.sessionId}`;

      session.pendingPreview = null;
      session.uploadDone = true;

      const reply = `🎉 Done! All data saved.\n\n📊 *Your Live Dashboard:*\n${dashboardUrl}\n\nBookmark it — it auto-refreshes! 🚀\n\nWould you like to activate your account?`;
      await client.sendMessage(msg.from, reply);
      session.history.push({ role: 'user', parts: [{ text: text }] });
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      return;
    } catch (err) {
      await client.sendMessage(msg.from, `❌ Error saving data: ${err.message}`);
      return;
    }
  }

  // Check if user is declining
  const noKeywords = ['no', 'cancel', 'nope', 'nahi', 'nah'];
  if (session.pendingPreview && noKeywords.some(k => text.toLowerCase().includes(k))) {
    session.pendingPreview = null;
    const reply = `No problem! 😊 Let me know if you'd like to upload a different file or if there's anything else I can help with.`;
    await client.sendMessage(msg.from, reply);
    session.history.push({ role: 'user', parts: [{ text: text }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    return;
  }

  // Check if user is confirming service activation
  if (session.uploadDone && confirmKeywords.some(k => text.toLowerCase().includes(k))) {
    session.confirmed = true;
    await db.confirmSession(session.sessionId).catch(() => {});
  }

  // Regular LLM chat — uses shared llm.js
  let contextNote = '';
  if (session.uploadDone) {
    contextNote = `[Context: Data uploaded. Dashboard: ${PUBLIC_URL}/dashboard/${session.sessionId}]`;
  } else if (session.awaitingUpload) {
    contextNote = '[Context: Already asked user to send Excel file. Remind them.]';
  }

  try {
    const reply = await chat(text, session.history, contextNote);
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    if (/upload|excel|xlsx|file|send|attach|spreadsheet/i.test(reply)) session.awaitingUpload = true;
    await client.sendMessage(msg.from, reply);
  } catch (err) {
    console.error('WA chat error:', err.message);
    await client.sendMessage(msg.from, `❌ ${err.message}`);
  }
}

// ─── Handle Excel file attachment ──────────────────────────────────────────
async function handleFileMessage(client, msg, session) {
  try {
    await client.sendMessage(msg.from, '📥 Got your file! Scanning it...');

    const media = await msg.downloadMedia();
    if (!media) {
      await client.sendMessage(msg.from, '❌ Could not download the file. Please try again.');
      return;
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(media.data, 'base64');
    const filename = msg._data?.filename || 'uploaded.xlsx';
    const ext = path.extname(filename).toLowerCase();

    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
      await client.sendMessage(msg.from, `❌ Please send an Excel file (.xlsx or .csv), not a ${ext} file.`);
      return;
    }

    const parsed = parseExcel(buffer);
    const lines = [];

    if (parsed.products.length > 0)  lines.push(`📦 *${parsed.products.length} Products* found`);
    if (parsed.orders.length > 0)    lines.push(`🛒 *${parsed.orders.length} Orders* found`);
    if (parsed.inventory.length > 0) lines.push(`🏪 *${parsed.inventory.length} Inventory items* found`);
    if (parsed.payments.length > 0)  lines.push(`💳 *${parsed.payments.length} Payment records* found`);

    if (lines.length === 0) {
      const reply = `❌ Couldn't read data from *${filename}*.\n\nMake sure your Excel columns are labelled:\n• Product Name, Price, SKU\n• Order ID, Customer Name\n• Stock, Reorder Level\n• Payment ID, Amount\n\nSend the corrected file!`;
      await client.sendMessage(msg.from, reply);
      return;
    }

    // Store in pending (don't save to DB yet)
    session.pendingPreview = {
      products: parsed.products,
      orders: parsed.orders,
      inventory: parsed.inventory,
      payments: parsed.payments,
      fileName: filename,
    };
    session.awaitingUpload = false;

    const sheetInfo = parsed.sheetSummary
      .map(s => `  • ${s.sheetName} → ${s.type} (${s.rowCount} rows)`)
      .join('\n');

    const reply = `✅ Scanned *${filename}*\n\n` +
      `Here's what I found:\n${lines.join('\n')}\n\n` +
      `📋 Sheets:\n${sheetInfo}\n\n` +
      `💾 *Should I store this data in your account?*\nReply *Yes* to save or *No* to cancel.`;

    session.history.push({ role: 'user', parts: [{ text: `[Sent Excel file: ${filename}]` }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    await client.sendMessage(msg.from, reply);

  } catch (err) {
    console.error('WA file error:', err.message);
    await client.sendMessage(msg.from, `❌ Error processing file: ${err.message}`);
  }
}

// ─── Initialize WhatsApp client ────────────────────────────────────────────
function initWhatsApp() {
  console.log('\n📱 Initializing WhatsApp connection...');
  console.log('   A QR code will appear below. Scan it with WhatsApp:\n');
  console.log('   WhatsApp → ⋮ Menu → Linked Devices → Link a Device → Scan QR\n');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wa-auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   📱 SCAN THIS QR CODE IN WHATSAPP   ║');
    console.log('╚══════════════════════════════════════╝\n');
    qrcode.generate(qr, { small: true });
    console.log('\n⏳ Waiting for scan...\n');
  });

  client.on('loading_screen', (percent, message) => {
    process.stdout.write(`\r⏳ Loading WhatsApp: ${percent}% — ${message}     `);
  });

  client.on('authenticated', () => {
    console.log('\n✅ WhatsApp authenticated!');
  });

  client.on('auth_failure', (msg) => {
    console.error('\n❌ WhatsApp auth failed:', msg);
    console.error('   Delete .wa-auth folder and restart to re-scan QR.\n');
  });

  client.on('ready', () => {
    console.log('\n🟢 WhatsApp is READY and connected!');
    console.log(`   Bot is listening for messages on your WhatsApp.`);
    console.log(`   Send a message FROM another phone TO this number to test.\n`);
  });

  client.on('disconnected', (reason) => {
    console.warn('\n🔴 WhatsApp disconnected:', reason);
    console.warn('   Attempting to reconnect in 5s...\n');
    setTimeout(() => client.initialize(), 5000);
  });

  // ─── Main message handler ──────────────────────────────────────────────
  client.on('message', async (msg) => {
    // Ignore group messages, status updates, and messages from self
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return; // skip group chats
    if (msg.fromMe) return; // skip own messages

    const phoneNumber = msg.from;
    const session = getSession(phoneNumber);  // ← shared sessions.js

    console.log(`\n📨 Message from ${phoneNumber}: ${msg.type === 'chat' ? msg.body?.substring(0, 50) : `[${msg.type}]`}`);

    try {
      if (msg.type === 'chat') {
        // Regular text message
        await handleTextMessage(client, msg, session, phoneNumber);
      } else if (msg.hasMedia && ['document', 'image'].includes(msg.type)) {
        // File or image attachment
        await handleFileMessage(client, msg, session);
      } else {
        await client.sendMessage(msg.from, `👋 Please send a text message or an Excel file (.xlsx) to get started!`);
      }
    } catch (err) {
      console.error('Message handler error:', err.message);
      try {
        await client.sendMessage(msg.from, '❌ Something went wrong. Please try again in a moment.');
      } catch {}
    }
  });

  client.initialize();
  return client;
}

module.exports = { initWhatsApp };
