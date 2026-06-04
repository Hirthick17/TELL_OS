// server.js - Main Express backend
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const { parseExcel }        = require('./parser');
const db                    = require('./db');
const { chat }              = require('./llm');
const { getSession, getSessionByPhone, persistSession, newSessionId } = require('./sessions');

// ─── Startup validation (minimum required vars) ──────────────────────────
const REQUIRED_ENV = ['GEMINI_API_KEY', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_VERIFY_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k] || process.env[k].startsWith('your_'));
if (missing.length) {
  console.warn(`⚠️  Missing or placeholder env vars: ${missing.join(', ')}`);
}

const app        = express();
const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ─── Warn loudly if dashboard URLs will be wrong ─────────────────────────
if (!process.env.PUBLIC_URL || process.env.PUBLIC_URL.includes('localhost')) {
  console.warn('⚠️  PUBLIC_URL not set — dashboard links will use localhost!');
  console.warn('   Set PUBLIC_URL=https://tell-os.onrender.com in Render env vars.');
} else {
  console.log(`🌐 Public URL: ${PUBLIC_URL}`);
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ─── GET /health ──────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    db:        dbOk ? 'connected' : 'unreachable',
    gemini:    !!process.env.GEMINI_API_KEY,
    uptime:    Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /chat ────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  try {
    const session = await getSession(sessionId);

    let contextNote = '';
    if (session.uploadDone) {
      contextNote = `[Context: Data uploaded. Dashboard: ${PUBLIC_URL}/dashboard/${sessionId}]`;
    } else if (session.awaitingUpload) {
      contextNote = '[Context: Already asked user to upload Excel. Remind them about the 📎 button.]';
    }

    let reply;
    try {
      reply = await chat(message, session.history, contextNote);
    } catch (llmErr) {
      // Surface API key / config errors gracefully
      const errMsg = `⚠️ ${llmErr.message}`;
      session.messages.push({ role: 'bot', text: errMsg, time: Date.now() });
      return res.json({ reply: errMsg, awaitingUpload: false, messages: session.messages });
    }

    // Update gemini history (raw user message, not with context)
    session.history.push({ role: 'user', parts: [{ text: message }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    // Update message log for client
    session.messages.push({ role: 'user', text: message, time: Date.now() });
    session.messages.push({ role: 'bot', text: reply, time: Date.now() });

    // Detect upload intent in bot reply
    const uploadKeywords = ['upload', 'excel', '.xlsx', 'file', 'attach', 'spreadsheet', 'send'];
    if (uploadKeywords.some(k => reply.toLowerCase().includes(k))) {
      session.awaitingUpload = true;
    }

    // Detect store confirmation — if user has pending preview data and says yes
    const confirmKeywords = ['yes', 'store', 'save', 'confirm', 'proceed', 'go ahead', 'sure', 'ok', 'done', 'yeah'];
    if (session.pendingPreview && confirmKeywords.some(k => message.toLowerCase().includes(k))) {
      // Store the pending data in DB
      const p = session.pendingPreview;
      try {
        if (p.products.length > 0) await db.insertProducts(sessionId, p.products);
        if (p.orders.length > 0) await db.insertOrders(sessionId, p.orders);
        if (p.inventory.length > 0) await db.insertInventory(sessionId, p.inventory);
        if (p.payments.length > 0) await db.insertPayments(sessionId, p.payments);
        const stats        = await db.getStats(sessionId);
        const dashboardUrl = `${PUBLIC_URL}/dashboard/${sessionId}`;
        const storeReply   = `🎉 Done! All data saved to your account.\n\n📊 Your live dashboard:\n${dashboardUrl}\n\nBookmark it — it refreshes every 10 seconds! 🚀`;
        session.pendingPreview = null;
        session.uploadDone     = true;
        session.messages.push({ role: 'bot', text: storeReply, dashboardUrl, time: Date.now() });
        session.history.push({ role: 'model', parts: [{ text: storeReply }] });
        persistSession(session);
        return res.json({ reply: storeReply, dashboardUrl, stats, confirmed: true, messages: session.messages });
      } catch (dbErr) {
        console.error('Store error:', dbErr.message);
        const dbErrMsg = `❌ Could not save data: ${dbErr.message}`;
        session.messages.push({ role: 'bot', text: dbErrMsg, time: Date.now() });
        return res.json({ reply: dbErrMsg, messages: session.messages });
      }
    }

    // Detect activation confirmation (after upload done)
    if (session.uploadDone && confirmKeywords.some(k => message.toLowerCase().includes(k))) {
      session.confirmed = true;
      await db.confirmSession(sessionId).catch(() => {});
    }

    persistSession(session);
    res.json({
      reply,
      awaitingUpload: session.awaitingUpload && !session.uploadDone,
      dashboardUrl: session.uploadDone ? `${PUBLIC_URL}/dashboard/${sessionId}` : null,
      confirmed: session.confirmed,
      messages: session.messages,
    });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── POST /upload — Preview first, don't store yet ────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  const { sessionId } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const session = await getSession(sessionId);
  const ext = path.extname(req.file.originalname).toLowerCase();

  // ── Image uploads ──────────────────────────────────────────────────────────
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
    const reply = `📸 Got your image! If you have business data, upload an Excel file (.xlsx) via 📎 so I can store it in your database.`;
    session.messages.push({ role: 'user', type: 'image', dataUrl, name: req.file.originalname, time: Date.now() });
    session.messages.push({ role: 'bot', text: reply, time: Date.now() });
    return res.json({ success: true, type: 'image', reply, dataUrl, messages: session.messages });
  }

  // ── Excel uploads — parse, preview, ask confirmation ──────────────────────
  try {
    const parsed = parseExcel(req.file.buffer);
    const lines = [];

    if (parsed.products.length > 0)  lines.push(`📦 *${parsed.products.length} Products* detected`);
    if (parsed.orders.length > 0)    lines.push(`🛒 *${parsed.orders.length} Orders* detected`);
    if (parsed.inventory.length > 0) lines.push(`🏪 *${parsed.inventory.length} Inventory items* detected`);
    if (parsed.payments.length > 0)  lines.push(`💳 *${parsed.payments.length} Payment records* detected`);

    if (lines.length === 0) {
      const reply = `❌ Couldn't read data from this file.\n\nMake sure columns have labels like:\n• Product Name, Price, SKU\n• Order ID, Customer Name, Amount\n• Stock, Reorder Level\n• Payment ID, Payment Method\n\nTry again with the correct format.`;
      session.messages.push({ role: 'user', type: 'file', name: req.file.originalname, time: Date.now() });
      session.messages.push({ role: 'bot', text: reply, time: Date.now() });
      return res.json({ success: false, reply, messages: session.messages });
    }

    // Store parsed data in session memory (pending confirmation)
    session.pendingPreview = {
      products: parsed.products,
      orders: parsed.orders,
      inventory: parsed.inventory,
      payments: parsed.payments,
      fileName: req.file.originalname,
    };
    session.awaitingUpload = false;

    // Build preview summary sheet info
    const sheetInfo = parsed.sheetSummary.map(s =>
      `  • ${s.sheetName} → ${s.type} (${s.rowCount} rows, ${s.headers.slice(0,3).join(', ')}...)`
    ).join('\n');

    const botReply = `✅ I've scanned your file *${req.file.originalname}*\n\n` +
      `Here's what I found:\n${lines.join('\n')}\n\n` +
      `📋 Sheet breakdown:\n${sheetInfo}\n\n` +
      `💾 Should I store this data in your account?\nReply *Yes* to save, or *No* to cancel.`;

    session.messages.push({ role: 'user', type: 'file', name: req.file.originalname, time: Date.now() });
    session.messages.push({ role: 'bot', text: botReply, hasPendingStore: true, time: Date.now() });
    session.history.push({ role: 'user', parts: [{ text: `[Uploaded file: ${req.file.originalname}]` }] });
    session.history.push({ role: 'model', parts: [{ text: botReply }] });

    res.json({
      success: true,
      type: 'preview',
      reply: botReply,
      preview: { products: parsed.products.length, orders: parsed.orders.length, inventory: parsed.inventory.length, payments: parsed.payments.length },
      hasPendingStore: true,
      messages: session.messages,
    });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: `File processing failed: ${err.message}` });
  }
});

// ─── GET /session/:sessionId/messages (restore chat history on page reload) ─────
app.get('/session/:sessionId/messages', async (req, res) => {
  const session = await getSession(req.params.sessionId);
  res.json({ messages: session ? session.messages : [] });
});

// ─── Meta WhatsApp Cloud API Webhook ───────────────────────────────────────
// Always registered — Meta needs GET /webhook to verify the endpoint.
// Full message handling only activates when phone ID + token are configured.
const { handleVerification, handleWebhook } = require('./meta-whatsapp');
app.get('/webhook', handleVerification);
app.post('/webhook', handleWebhook);
console.log('📲 Meta webhook routes: GET /webhook, POST /webhook');
if (process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN) {
  console.log('✅ Meta WhatsApp fully configured — messages will be processed');
} else {
  console.log('⚠️  META_PHONE_NUMBER_ID or META_ACCESS_TOKEN missing — messages logged only');
}

// ─── GET /dashboard/:sessionId ─────────────────────────────────────────────
app.get('/dashboard/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const stats = await db.getStats(sessionId);
    const data = await db.getTableData(sessionId);
    res.send(renderDashboard(sessionId, stats, data));
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).send(`<pre style="color:red;padding:20px">❌ ${err.message}\n\nMake sure MongoDB is running.</pre>`);
  }
});

// ─── GET /api/stats/:sessionId ─────────────────────────────────────────────
app.get('/api/stats/:sessionId', async (req, res) => {
  try {
    const stats = await db.getStats(req.params.sessionId);
    const data = await db.getTableData(req.params.sessionId);
    res.json({ stats, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard HTML ────────────────────────────────────────────────────────
function renderDashboard(sessionId, stats, data) {
  const revenue = (stats.revenue || 0).toFixed(2);

  function renderTable(rows, label) {
    if (!rows || rows.length === 0) return `<p class="no-data">No ${label} data uploaded yet.</p>`;
    const exclude = ['session_id', 'created_at'];
    const keys = Object.keys(rows[0]).filter(k => !exclude.includes(k));
    return `<div class="table-wrapper"><table>
      <thead><tr>${keys.map(k => `<th>${k.replace(/_/g,' ').toUpperCase()}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${keys.map(k => `<td>${r[k]??''}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ShopBot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0a0e1a;--surface:#111827;--card:#1a2235;--border:#243047;--accent:#25d366;--text:#f0f4ff;--muted:#8899bb}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    header{background:linear-gradient(135deg,#0d1f1a,#1a3a2e);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
    .logo{display:flex;align-items:center;gap:12px}
    .logo-icon{width:40px;height:40px;background:var(--accent);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px}
    .live-badge{display:flex;align-items:center;gap:8px;background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.3);padding:6px 14px;border-radius:20px;font-size:.75rem;color:var(--accent)}
    .live-dot{width:8px;height:8px;background:var(--accent);border-radius:50%;animation:pulse 1.5s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .container{max-width:1200px;margin:0 auto;padding:32px}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;margin-bottom:40px}
    .stat-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;transition:transform .2s}
    .stat-card:hover{transform:translateY(-2px)}
    .stat-icon{font-size:2rem;margin-bottom:12px}
    .stat-value{font-size:2.5rem;font-weight:800;line-height:1}
    .stat-label{font-size:.85rem;color:var(--muted);margin-top:6px}
    .stat-card.products{border-top:3px solid var(--accent)}
    .stat-card.orders{border-top:3px solid #3498db}
    .stat-card.inventory{border-top:3px solid #ffa502}
    .stat-card.revenue{border-top:3px solid #a855f7}
    .tab-bar{display:flex;gap:4px;background:var(--surface);border-radius:12px;padding:4px;margin-bottom:24px;width:fit-content}
    .tab{padding:8px 20px;border-radius:8px;font-size:.85rem;font-weight:500;cursor:pointer;color:var(--muted);transition:all .2s;border:none;background:none}
    .tab.active{background:var(--card);color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,.3)}
    .tab-content{display:none}.tab-content.active{display:block}
    .section-header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
    .section-title{font-size:1.1rem;font-weight:700}
    .count-badge{background:rgba(37,211,102,.15);color:var(--accent);padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
    .table-wrapper{overflow-x:auto;border-radius:12px;border:1px solid var(--border)}
    table{width:100%;border-collapse:collapse;background:var(--card)}
    thead{background:rgba(255,255,255,.03)}
    th{padding:12px 16px;text-align:left;font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);white-space:nowrap}
    td{padding:12px 16px;font-size:.85rem;border-bottom:1px solid rgba(255,255,255,.04)}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(255,255,255,.02)}
    .no-data{color:var(--muted);padding:32px;text-align:center;font-size:.9rem}
    .refresh-bar{position:fixed;bottom:24px;right:24px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 18px;font-size:.8rem;color:var(--muted);display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(0,0,0,.4)}
    .back-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(37,211,102,.1);border:1px solid rgba(37,211,102,.3);color:var(--accent);padding:8px 16px;border-radius:8px;font-size:.85rem;text-decoration:none;margin-bottom:24px;transition:background .2s}
    .back-btn:hover{background:rgba(37,211,102,.2)}
  </style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">🛍️</div>
    <div><h1 style="font-size:1.25rem;font-weight:700">ShopBot Dashboard</h1><p style="font-size:.75rem;color:var(--muted);margin-top:2px">Session: ${sessionId.substring(0,12)}...</p></div>
  </div>
  <div class="live-badge"><div class="live-dot"></div>LIVE</div>
</header>
<div class="container">
  <a href="/" class="back-btn">← Back to Chat</a>
  <div class="stats-grid">
    <div class="stat-card products"><div class="stat-icon">📦</div><div class="stat-value" id="sp">${stats.products}</div><div class="stat-label">Products</div></div>
    <div class="stat-card orders"><div class="stat-icon">🛒</div><div class="stat-value" id="so">${stats.orders}</div><div class="stat-label">Orders</div></div>
    <div class="stat-card inventory"><div class="stat-icon">🏪</div><div class="stat-value" id="si">${stats.inventory}</div><div class="stat-label">Inventory Items</div></div>
    <div class="stat-card revenue"><div class="stat-icon">💰</div><div class="stat-value" id="sr">₹${revenue}</div><div class="stat-label">Total Revenue</div></div>
  </div>
  <div class="tab-bar">
    <button class="tab active" onclick="switchTab('products',this)">📦 Products</button>
    <button class="tab" onclick="switchTab('orders',this)">🛒 Orders</button>
    <button class="tab" onclick="switchTab('inventory',this)">🏪 Inventory</button>
    <button class="tab" onclick="switchTab('payments',this)">💳 Payments</button>
  </div>
  <div id="tab-products" class="tab-content active">
    <div class="section-header"><span class="section-title">Products</span><span class="count-badge">${data.products.length} items</span></div>
    ${renderTable(data.products,'product')}
  </div>
  <div id="tab-orders" class="tab-content">
    <div class="section-header"><span class="section-title">Orders</span><span class="count-badge">${data.orders.length} records</span></div>
    ${renderTable(data.orders,'order')}
  </div>
  <div id="tab-inventory" class="tab-content">
    <div class="section-header"><span class="section-title">Inventory</span><span class="count-badge">${data.inventory.length} items</span></div>
    ${renderTable(data.inventory,'inventory')}
  </div>
  <div id="tab-payments" class="tab-content">
    <div class="section-header"><span class="section-title">Payments</span><span class="count-badge">${data.payments.length} records</span></div>
    ${renderTable(data.payments,'payment')}
  </div>
</div>
<div class="refresh-bar">🔄 <span id="rc">Auto-refresh in 10s</span></div>
<script>
  function switchTab(n,el){
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('tab-'+n).classList.add('active');
  }
  let cd=10;
  setInterval(()=>{
    cd--;document.getElementById('rc').textContent='Auto-refresh in '+cd+'s';
    if(cd<=0){cd=10;fetch('/api/stats/${sessionId}').then(r=>r.json()).then(d=>{
      if(d.stats){
        document.getElementById('sp').textContent=d.stats.products;
        document.getElementById('so').textContent=d.stats.orders;
        document.getElementById('si').textContent=d.stats.inventory;
        document.getElementById('sr').textContent='₹'+(d.stats.revenue||0).toFixed(2);
      }
    }).catch(()=>{});}
  },1000);
</script>
</body>
</html>`;
}

// ─── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 ShopBot running on port ${PORT}`);
  console.log(`📱 Chat UI:   ${PUBLIC_URL}`);
  console.log(`📊 Dashboard: ${PUBLIC_URL}/dashboard/{sessionId}\n`);
  db.connect().catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.error('   Start MongoDB service first.\n');
  });

  // ── Keep Render free tier awake (pings self every 14 min) ──────────────
  // Render spins down after 15 min of inactivity — Meta webhook calls will
  // fail silently if the server is sleeping. This prevents that.
  if (PUBLIC_URL && !PUBLIC_URL.includes('localhost')) {
    const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
    setInterval(async () => {
      try {
        const http = require('http');
        const https = require('https');
        const lib = PUBLIC_URL.startsWith('https') ? https : http;
        lib.get(`${PUBLIC_URL}/health`, (res) => {
          console.log(`💓 Keep-alive ping → ${res.statusCode}`);
        }).on('error', () => {}); // silent on error
      } catch (_) {}
    }, PING_INTERVAL);
    console.log(`💓 Keep-alive enabled — pinging ${PUBLIC_URL}/health every 14 min`);
  }

  // Start WhatsApp if enabled
  if (process.env.WHATSAPP_ENABLED === 'true') {
    const { initWhatsApp } = require('./whatsapp');
    initWhatsApp();
  }
});
