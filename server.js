// server.js - Main Express backend
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const { detectSheetsAndColumns, streamSheet, extractSamples, buildSheetMetadata, parseExcel } = require('./parser');
const db                    = require('./db');
const { chat, friendlyLLMError } = require('./llm');
const intelligence = require('./intelligence');
const { getSession, getSessionByPhone, persistSession, newSessionId } = require('./sessions');
const {
  routePathway,
  resolveAnalyticsIntent,
  formatAnalyticsReply,
} = require('./intent-router');
const { classifyIntent }                              = require('./intent-classifier');
const {
  storeMissedIntent,
  backfillCorrectIntent,
  getMissedIntents,
  resolveMissedIntent,
  getMissedIntentStats,
} = require('./missed-intents');

// ─── NEW: Query Planning Engine ────────────────────────────────────────────────
// Converts user questions to structured query plans without ERP assumptions
const QueryPlanner = {
  /**
   * Analyze a user question and build a structured query plan
   * Returns: { operation, field, aggregation, filters, groupBy, limit }
   */
  async buildQueryPlan(question, datasetId, metadata) {
    return intelligence.buildQueryPlan(question, datasetId, metadata);
  },
};

// ─── REMOVED: Old ERP INTENT_TO_QUERY mapping ───────────────────────────────
// The system is now fully flexible and dataset-centric. No more hardcoded
// product/order/inventory/payment queries. All analytics are driven by
// dynamically detected dataset metadata and user questions.


const REQUIRED_ENV = ['GEMINI_API_KEY', 'NIM_KEY', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_VERIFY_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k] || process.env[k].startsWith('your_'));
if (missing.length) {
  console.warn(`⚠️  Missing or placeholder env vars: ${missing.join(', ')}`);
}

console.log("=== ENV CHECK ===");
console.log("MongoDB:", !!(process.env.MONGO_URL || process.env.MONGODB_URI));
console.log("NVIDIA NIM:", !!process.env.NIM_KEY);
console.log("Gemini API:", !!process.env.GEMINI_API_KEY);
console.log("Meta Phone ID:", !!process.env.META_PHONE_NUMBER_ID);
console.log("Public URL:", process.env.PUBLIC_URL || "(not set, using localhost)");
console.log("=================");

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

const corsOrigin = process.env.FRONTEND_URL || '*';
app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
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

// ─── POST /chat ─────────────────────────────────────────────────────────────
const trace = require('./trace');

app.post('/chat', async (req, res) => {
  const traceId = trace.generateTraceId();
  await trace.runWithTraceId(traceId, async () => {
    const { message, sessionId } = req.body;
    console.log("User question:", message);
    trace.logRequestReceived('Frontend', '/chat', req.body);
    trace.logFunctionEntered('server.js', 'chatRoute', req.body, 'Frontend');

    if (!message || !sessionId) {
      const errRes = { error: 'message and sessionId are required' };
      trace.logResponseSent(errRes);
      trace.logFunctionResult('server.js', 'chatRoute', errRes, 0);
      return res.status(400).json(errRes);
    }

    try {
      const tStart = Date.now();
      trace.logDataTransfer('chatRoute', 'getSession', { sessionId });
      const session = await getSession(sessionId);
      trace.logFunctionResult('sessions.js', 'getSession', { hasSession: !!session }, 0);

      const hostUrl = (req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1'))
        ? `http://${req.get('host')}`
        : PUBLIC_URL;

      const oldState = {
        pendingConfirmation: session.pendingConfirmation,
        activeFlow: session.activeFlow
      };
      
      // Sync derived flags
      session.pendingConfirmation = !!(session.pendingPreview || session.pendingUploadPlan);
      if (session.pendingPreview || session.awaitingUpload) session.activeFlow = 'data_entry';

      const newState = {
        pendingConfirmation: session.pendingConfirmation,
        activeFlow: session.activeFlow
      };
      trace.logDataTransformation(oldState, newState);

      // ── STEP 1: Hard safety + onboarding gates (fast, no LLM) ────────────
      trace.logDataTransfer('chatRoute', 'routePathway', { message, sessionKeys: Object.keys(session) });
      const pathway = await routePathway(message, session);

      if (pathway.route === 'safety_block') {
        const reply = `⚠️ That action isn't available through chat. To manage or reset your data, please contact support.`;
        session.messages.push({ role: 'user', text: message, time: Date.now() });
        session.messages.push({ role: 'bot',  text: reply,   time: Date.now() });
        trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
        persistSession(session);
        const finalRes = { reply, messages: session.messages };
        trace.logResponseSent(finalRes);
        trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
        return res.json(finalRes);
      }

      if (pathway.route === 'onboarding') {
        const ctx = session.uploadDone
          ? `[Context: User uploaded data. Dashboard: ${hostUrl}/dashboard/${sessionId}. Explain analytics features available.]`
          : `[Context: User asking for help. Explain what ShopBot does — Excel upload, live dashboard, AI analytics.]`;
        try {
          trace.logDataTransfer('chatRoute', 'chat', { message, ctx });
          const reply = await chat(message, session.history, ctx);
          session.history.push({ role: 'user',  parts: [{ text: message }] });
          session.history.push({ role: 'model', parts: [{ text: reply }] });
          session.messages.push({ role: 'user', text: message, time: Date.now() });
          session.messages.push({ role: 'bot',  text: reply,   time: Date.now() });
          trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
          persistSession(session);
          const finalRes = { reply, messages: session.messages };
          trace.logResponseSent(finalRes);
          trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
          return res.json(finalRes);
        } catch (llmErr) {
          trace.logError('chatRoute:onboarding', { message }, llmErr, 'LLM chat call');
          const errMsg = friendlyLLMError(llmErr);
          session.messages.push({ role: 'bot', text: errMsg, time: Date.now() });
          const finalRes = { reply: errMsg, messages: session.messages };
          trace.logResponseSent(finalRes);
          trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
          return res.json(finalRes);
        }
      }

      // ── STEP 2: Gemini JSON intent classifier ─────────────────────────────
      // Skip classifier when a Layer 1 hard gate has already resolved the route
      const skipClassifier = pathway.route !== 'pass_to_classifier';
      let classification;

      if (skipClassifier) {
        // Use the existing pathway result directly
        classification = {
          intent:           pathway.route === 'data_analytics' ? 'DATA_ANALYTICS' : 'DATA_INGESTION',
          confidence:       0.95,
          signals_detected: ['active_flow_in_progress'],
          conflict:         false,
          conflict_note:    '',
          route:            pathway.route,
          fallback_used:    true,
          raw_response:     '',
        };
      } else {
        const msgMeta = req.body.messageMetadata || {};
        trace.logDataTransfer('chatRoute', 'classifyIntent', { message, msgMeta });
        classification = await classifyIntent(message, msgMeta, session);
        console.log(`🎯 Classified: ${classification.intent} (${classification.confidence.toFixed(2)}) fallback=${classification.fallback_used} | ${sessionId.slice(0, 8)}`);
      }

      // ── STEP 3: Threshold gate ─────────────────────────────────────────────
      // P0 FIX: When Gemini failed and fallback router was used, trust its route
      // directly — skip the confidence threshold gate entirely. The fallback
      // router is our regex-based routePathway() which is already reliable.
      // Without this, fallback confidence (0.60) always triggers clarification.
      if (classification.fallback_used && classification.route !== 'clarification') {
        console.log(`🔀 Fallback route trusted: ${classification.route} (bypassing threshold gate)`);
        classification.confidence = 0.85; // treat fallback route as high-confidence
      }

      const { intent, confidence, conflict } = classification;
      console.log("Intent:", intent);
      const THRESHOLD_ROUTE  = 0.80;
      const THRESHOLD_LOG    = 0.65;

      // Conflict → always clarification regardless of confidence
      if (conflict && !skipClassifier) {
        const clarifyReply = buildConflictReply(classification);
        session.messages.push({ role: 'user', text: message, time: Date.now() });
        session.messages.push({ role: 'bot',  text: clarifyReply, time: Date.now() });
        trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
        persistSession(session);
        // Store for review
        storeMissedIntent({
          message_text:     message,
          message_metadata: req.body.messageMetadata || {},
          returned_intent:  intent,
          confidence,
          signals_detected: classification.signals_detected,
          conflict:         true,
          conflict_note:    classification.conflict_note,
          session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: sessionId },
          reason:           'conflict',
        }).catch(() => {});
        const finalRes = { reply: clarifyReply, messages: session.messages };
        trace.logResponseSent(finalRes);
        trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
        return res.json(finalRes);
      }

      // Low confidence → clarification + log
      if (confidence < THRESHOLD_LOG && !skipClassifier) {
        const clarifyReply = buildLowConfidenceReply();
        session.messages.push({ role: 'user', text: message, time: Date.now() });
        session.messages.push({ role: 'bot',  text: clarifyReply, time: Date.now() });
        trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
        persistSession(session);
        storeMissedIntent({
          message_text:     message,
          message_metadata: req.body.messageMetadata || {},
          returned_intent:  intent,
          confidence,
          signals_detected: classification.signals_detected,
          conflict:         false,
          conflict_note:    '',
          session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: sessionId },
          reason:           'low_confidence',
        }).catch(() => {});
        const finalRes = { reply: clarifyReply, messages: session.messages };
        trace.logResponseSent(finalRes);
        trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
        return res.json(finalRes);
      }

      // Medium confidence (0.65–0.79) → route but log for review
      if (confidence < THRESHOLD_ROUTE && !skipClassifier) {
        storeMissedIntent({
          message_text:     message,
          message_metadata: req.body.messageMetadata || {},
          returned_intent:  intent,
          confidence,
          signals_detected: classification.signals_detected,
          conflict:         false,
          conflict_note:    '',
          session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: sessionId },
          reason:           'medium_confidence',
        }).catch(() => {});
      }

      // High confidence → backfill any previous unresolved intent for this session
      if (confidence >= THRESHOLD_ROUTE && !skipClassifier && session.lastClassifiedIntent) {
        backfillCorrectIntent(sessionId, intent, message).catch(() => {});
      }

      // Update session with this classification
      const sessionOldClass = {
        lastClassifiedIntent: session.lastClassifiedIntent,
        lastRoute: session.lastRoute,
        activeFlow: session.activeFlow
      };
      session.lastClassifiedIntent = intent;
      session.lastRoute             = classification.route;
      session.activeFlow            = classification.route === 'data_analytics' ? 'data_analytics' : 'data_entry';
      session.recentRoutes          = [...(session.recentRoutes || []).slice(-4), classification.route];
      
      const sessionNewClass = {
        lastClassifiedIntent: session.lastClassifiedIntent,
        lastRoute: session.lastRoute,
        activeFlow: session.activeFlow
      };
      trace.logDataTransformation(sessionOldClass, sessionNewClass);

      // ── STEP 4: Route to the correct pathway ──────────────────────────────
      const effectiveRoute = classification.route;

      // ─────────────────────────────────────────────────────────────────────
      // DATA ANALYTICS PATHWAY (NEW: Flexible, dataset-driven)
      // ─────────────────────────────────────────────────────────────────────
      if (effectiveRoute === 'data_analytics') {
        try {
          trace.logDataTransfer('chatRoute', 'db.buildLLMContext', { sessionId });
          const metaCtxAnalytics = await db.buildLLMContext(sessionId).catch(() => null);
          const stats = await db.getStats(sessionId).catch(() => null);
          const datasetId = stats?.latestDatasetId;
          let queryResult = null;
          let queryPlan = null;
          let executed = false;

          if (datasetId) {
            console.log("Selected dataset:", datasetId);
            const db_conn = await db.connect();
            const metadata = await db_conn.collection('dataset_metadata').findOne({ datasetId }).catch(() => null);
            if (metadata) {
              try {
                queryPlan = await QueryPlanner.buildQueryPlan(message, datasetId, metadata);
                if (queryPlan && queryPlan.operation === 'aggregate' && queryPlan.field) {
                  queryResult = await db.executeQueryPlan(sessionId, datasetId, queryPlan);
                  console.log("Rows returned:", queryResult?.results?.length || 0);
                  executed = true;
                }
              } catch (planErr) {
                console.warn('Intelligence query execution failed:', planErr.message);
              }
            }
          }

          let responseContext = `[Context: You are ShopBot, a WhatsApp commerce assistant. The user asked: "${message}".`;
          if (executed && queryResult) {
            responseContext += ` We ran a database query plan: ${JSON.stringify(queryPlan)} and got the results: ${JSON.stringify(queryResult)}.`;
            responseContext += ` Formulate a concise, friendly WhatsApp reply (short, with emojis) presenting this exact database result to the user.`;
          } else {
            responseContext += metaCtxAnalytics 
              ? ` Answer their analytics question DIRECTLY using the data context below:\n\nAvailable Merchant Datasets:\n${metaCtxAnalytics}`
              : ` Answer their analytics question based on the actual data structure, not assumptions.`;
          }
          responseContext += ` Be concise and WhatsApp-friendly (short, use emojis, no markdown). Never assume business categories or ERP structures. Answer based on what's actually in the query plan or data.]`;

          trace.logDataTransfer('chatRoute', 'chat', { message, responseContext: responseContext.slice(0, 150) });
          const reply = await chat(message, session.history, responseContext);
          
          console.log(`📊 Flexible Analytics: ${sessionId.slice(0, 8)} | ${message.slice(0, 60)}`);
          session.history.push({ role: 'user',  parts: [{ text: message }] });
          session.history.push({ role: 'model', parts: [{ text: reply }] });
          session.messages.push({ role: 'user', text: message, time: Date.now() });
          session.messages.push({ role: 'bot',  text: reply,   time: Date.now() });
          trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
          persistSession(session);
          const finalRes = { reply, messages: session.messages };
          trace.logResponseSent(finalRes);
          trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
          return res.json(finalRes);
        } catch (analyticsErr) {
          trace.logError('chatRoute:analyticsPathway', { sessionId }, analyticsErr, 'Flexible analytics processing');
          console.error('Analytics pathway error:', analyticsErr.message);
          const errMsg = friendlyLLMError(analyticsErr);
          session.messages.push({ role: 'bot', text: errMsg, time: Date.now() });
          const finalRes = { reply: errMsg, messages: session.messages };
          trace.logResponseSent(finalRes);
          trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
          return res.json(finalRes);
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // DATA ENTRY PATHWAY
      // Handles EXCEL_UPLOAD, IMAGE_UPLOAD, DATA_INGESTION, and confirmations
      // ─────────────────────────────────────────────────────────────────────

      // Build context note enriched with metadata
      let contextNote = '';
      if (session.uploadDone) {
        trace.logDataTransfer('chatRoute', 'db.buildLLMContext', { sessionId });
        const metaCtx = await db.buildLLMContext(sessionId).catch(() => null);
        contextNote = metaCtx
          ? `[Context: Data uploaded. Dashboard: ${hostUrl}/dashboard/${sessionId}\n${metaCtx}]`
          : `[Context: Data uploaded. Dashboard: ${hostUrl}/dashboard/${sessionId}]`;
      } else if (session.awaitingUpload) {
        contextNote = '[Context: Already asked user to upload Excel. Remind them about the 📎 button.]';
      } else if (intent === 'EXCEL_UPLOAD') {
        contextNote = '[Context: Merchant wants to upload an Excel file. Guide them to use the 📎 attachment button.]';
        session.awaitingUpload = true;
      } else if (intent === 'IMAGE_UPLOAD') {
        contextNote = '[Context: Merchant is sending a photo of business records. Ask them to send the image using the 📎 button, or upload an Excel file for better accuracy.]';
      }

      // Pending confirmation (new streaming path)
      const confirmKeywords = ['yes', 'store', 'save', 'confirm', 'proceed', 'go ahead', 'sure', 'ok', 'done', 'yeah'];
      if (session.pendingUploadPlan && confirmKeywords.some(k => message.toLowerCase().includes(k))) {
        try {
          const http = require('http');
          const body = JSON.stringify({ sessionId });
          const reqOptions = {
            hostname: '127.0.0.1',
            port: PORT,
            path: '/upload/confirm',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          };
          const internalReq = http.request(reqOptions);
          internalReq.on('error', () => {});
          internalReq.write(body);
          internalReq.end();

          const processingMsg = `⏳ Got it! Saving your data now...\n\nThis may take a moment for large files. I'll let you know when it's done! 📊`;
          session.messages.push({ role: 'user', text: message, time: Date.now() });
          session.messages.push({ role: 'bot',  text: processingMsg, time: Date.now() });
          session.history.push({ role: 'user',  parts: [{ text: message }] });
          session.history.push({ role: 'model', parts: [{ text: processingMsg }] });
          trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
          persistSession(session);
          const finalRes = { reply: processingMsg, processing: true, messages: session.messages };
          trace.logResponseSent(finalRes);
          trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
          return res.json(finalRes);
        } catch (confirmErr) {
          trace.logError('chatRoute:confirmStreaming', { sessionId }, confirmErr, 'Trigger confirm internal request');
          console.error('Confirm trigger error:', confirmErr.message);
        }
      }

      // Regular Gemini chat response
      let reply;
      try {
        trace.logDataTransfer('chatRoute', 'chat', { message, contextNote });
        reply = await chat(message, session.history, contextNote);
      } catch (llmErr) {
        trace.logError('chatRoute:dataEntryChat', { message }, llmErr, 'Gemini chat call');
        const errMsg = friendlyLLMError(llmErr);
        session.messages.push({ role: 'bot', text: errMsg, time: Date.now() });
        const finalRes = { reply: errMsg, awaitingUpload: false, messages: session.messages };
        trace.logResponseSent(finalRes);
        trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
        return res.json(finalRes);
      }

      session.history.push({ role: 'user',  parts: [{ text: message }] });
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      session.messages.push({ role: 'user', text: message, time: Date.now() });
      session.messages.push({ role: 'bot',  text: reply,   time: Date.now() });

      // Detect upload intent in bot reply
      const uploadKeywords = ['upload', 'excel', '.xlsx', 'file', 'attach', 'spreadsheet', 'send'];
      if (uploadKeywords.some(k => reply.toLowerCase().includes(k))) {
        session.awaitingUpload = true;
      }
      if (session.uploadDone && confirmKeywords.some(k => message.toLowerCase().includes(k))) {
        session.confirmed = true;
        await db.confirmSession(sessionId).catch(() => {});
      }

      trace.logDataTransfer('chatRoute', 'persistSession', { sessionKeys: Object.keys(session) });
      persistSession(session);
      const finalRes = {
        reply,
        intent:        intent || null,
        confidence:    confidence || null,
        awaitingUpload: session.awaitingUpload && !session.uploadDone,
        dashboardUrl:  session.uploadDone ? `${hostUrl}/dashboard/${sessionId}` : null,
        confirmed:     session.confirmed,
        messages:      session.messages,
      };
      trace.logResponseSent(finalRes);
      trace.logFunctionResult('server.js', 'chatRoute', finalRes, Date.now() - tStart);
      res.json(finalRes);

    } catch (err) {
      trace.logError('chatRoute', { message, sessionId }, err, 'Global chat route handler try-catch');
      console.error('Chat error:', err.message);
      const finalRes = { error: 'Something went wrong. Please try again.' };
      trace.logResponseSent(finalRes);
      res.status(500).json(finalRes);
    }
  });
});

// ─── Clarification reply builders ─────────────────────────────────────────
function buildConflictReply(classification) {
  const note = classification.conflict_note || 'your request had mixed signals';
  return (
    `🤔 I see two possible things you need — ${note}\n\n` +
    `Could you clarify?\n` +
    `📊 If you want to *see* your data — ask "show my revenue" or "what's my stock"\n` +
    `📂 If you want to *update* data — say "fix the price" or "upload new file"`
  );
}

function buildLowConfidenceReply() {
  return (
    `I didn't quite catch that. Did you want to:\n\n` +
    `*1.* 📊 Check your analytics — orders, stock, revenue\n` +
    `*2.* 📂 Upload or update your data\n` +
    `*3.* ❓ Something else\n\n` +
    `Just reply with a number or rephrase your question!`
  );
}

// ─── POST /upload — Detect columns only, return preview + confidence flags ────
app.post('/upload', upload.single('file'), async (req, res) => {
  const { sessionId } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  console.log("Upload received:", req.file.originalname);
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const session = await getSession(sessionId);
  const ext = path.extname(req.file.originalname).toLowerCase();

  // ── Image uploads ──────────────────────────────────────────────────────────
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    const base64  = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
    const reply   = `📸 Got your image! If you have business data, upload an Excel file (.xlsx) via 📎 so I can store it in your database.`;
    session.messages.push({ role: 'user', type: 'image', dataUrl, name: req.file.originalname, time: Date.now() });
    session.messages.push({ role: 'bot', text: reply, time: Date.now() });
    return res.json({ success: true, type: 'image', reply, dataUrl, messages: session.messages });
  }

  // ── Excel uploads — detect columns, build preview ─────────────────────────
  try {
    // Phase 1: headers-only detection (fast, no data loaded)
    const plan = detectSheetsAndColumns(req.file.buffer);

    const knownSheets = plan.sheets;
    if (knownSheets.length === 0) {
      const reply = `❌ Couldn't read data from this file.\n\nMake sure columns have labels like:\n• Product Name, Price, SKU\n• Order ID, Customer Name, Amount\n• Stock, Reorder Level\n• Payment ID, Payment Method\n\nTry again with the correct format.`;
      session.messages.push({ role: 'user', type: 'file', name: req.file.originalname, time: Date.now() });
      session.messages.push({ role: 'bot', text: reply, time: Date.now() });
      persistSession(session);
      return res.json({ success: false, reply, messages: session.messages });
    }

    // Build summary lines
    const typeCounts = {};
    for (const s of knownSheets) {
      typeCounts[s.type] = (typeCounts[s.type] || 0) + s.rowCount;
    }
    const EMOJI = { products: '📦', orders: '🛒', inventory: '🏪', payments: '💳' };
    const lines = Object.entries(typeCounts).map(([t, c]) => `${EMOJI[t] || '📄'} *${c} ${t.charAt(0).toUpperCase()+t.slice(1)}* detected`);

    // Sheet breakdown with column confidence info
    const sheetInfo = knownSheets.map(s => {
      const lowConf = Object.entries(s.confidences || {}).filter(([, v]) => v < 0.9).map(([k]) => k);
      const flagNote = lowConf.length > 0 ? ` ⚠️ (low confidence: ${lowConf.join(', ')})` : '';
      return `  • ${s.sheetName} → ${s.type} (${s.rowCount} rows, cols: ${s.headers.slice(0,3).join(', ')}...)${flagNote}`;
    }).join('\n');

    // Build column confirmation prompts for any unmatched headers
    const unmatchedBySheet = knownSheets
      .filter(s => s.unmatchedHeaders && s.unmatchedHeaders.length > 0)
      .map(s => `  • ${s.sheetName}: ${s.unmatchedHeaders.join(', ')}`)
      .join('\n');

    // Store plan in session for /upload/confirm
    session.pendingUploadPlan = {
      sheetPlans: plan.sheets,
      fileBuffer: req.file.buffer.toString('base64'),   // base64 for session storage
      fileName:   req.file.originalname,
    };
    session.awaitingUpload = false;

    let botReply = `✅ I've scanned *${req.file.originalname}*\n\n` +
      `Here's what I found:\n${lines.join('\n')}\n\n` +
      `📋 Sheet breakdown:\n${sheetInfo}`;

    if (unmatchedBySheet) {
      botReply += `\n\n⚠️ Some columns couldn't be auto-identified:\n${unmatchedBySheet}\n` +
        `These will be stored with their original names.`;
    }

    botReply += `\n\n💾 Should I store this data in your account?\nReply *Yes* to save, or *No* to cancel.`;

    session.messages.push({ role: 'user', type: 'file', name: req.file.originalname, time: Date.now() });
    session.messages.push({ role: 'bot', text: botReply, hasPendingStore: true, time: Date.now() });
    session.history.push({ role: 'user',  parts: [{ text: `[Uploaded file: ${req.file.originalname}]` }] });
    session.history.push({ role: 'model', parts: [{ text: botReply }] });
    persistSession(session);

    res.json({
      success: true,
      type: 'preview',
      reply: botReply,
      preview: typeCounts,
      hasPendingStore: true,
      needsConfirmation: plan.needsConfirmation,
      sheetPlans: plan.sheets.map(s => ({
        sheetName:        s.sheetName,
        type:             s.type,
        rowCount:         s.rowCount,
        columnMap:        s.columnMap,
        confidences:      s.confidences,
        unmatchedHeaders: s.unmatchedHeaders,
      })),
      messages: session.messages,
    });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: `File processing failed: ${err.message}` });
  }
});

// ─── POST /upload/confirm — Stream insert all sheets in batches of 200 ────────
app.post('/upload/confirm', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = await getSession(sessionId);
    const plan    = session.pendingUploadPlan;
    if (!plan) return res.status(400).json({ error: 'No pending upload. Upload a file first.' });

    // Acknowledge immediately — streaming happens async
    session.uploadProgress = { status: 'processing', total: 0, inserted: 0, startedAt: Date.now() };
    persistSession(session);
    res.json({ success: true, status: 'processing', message: 'Streaming insert started. Poll /api/upload-status/:sessionId for progress.' });

    // ── Async streaming insert (after response sent) ──────────────────────────
    setImmediate(async () => {
    try {
      const fileBuffer = Buffer.from(plan.fileBuffer, 'base64');
      const knownSheets = plan.sheetPlans.filter(s => s.type !== 'unknown');

      // Count total rows across all sheets
      const totalRows = knownSheets.reduce((sum, s) => sum + s.rowCount, 0);
      session.uploadProgress.total = totalRows;

      const { datasetId } = await db.prepareUploadSession(
        sessionId,
        plan.fileName,
        knownSheets
      );
      console.log("Dataset created:", datasetId);

      // Collect metadata per sheet
      const metaSheets = [];
      let insertedTotal = 0;

      for (const sheetPlan of knownSheets) {
        let sheetRows = 0;
        let firstBatchRows = null;

        let startRow = 1;
        await streamSheet(fileBuffer, sheetPlan.sheetName, async (batch) => {
          await db.insertDatasetRecordsBatch(
            sessionId,
            datasetId,
            sheetPlan.sheetName,
            batch,
            startRow
          );
          startRow += batch.length;
          sheetRows    += batch.length;
          insertedTotal += batch.length;
          if (!firstBatchRows) firstBatchRows = batch;

          // Live progress update
          session.uploadProgress.inserted = insertedTotal;
          persistSession(session);
        });

        // Extract sample values from first batch for LLM context
        const sampleValues = firstBatchRows
          ? extractSamples(firstBatchRows, sheetPlan.columnMap, 3)
          : {};

        const sheetMeta = buildSheetMetadata(sheetPlan, firstBatchRows || []);

        metaSheets.push({
          sheetName:        sheetPlan.sheetName,
          semanticType:     sheetPlan.type,
          rowCount:         sheetRows,
          columnMap:        sheetPlan.columnMap,
          confidences:      sheetPlan.confidences,
          unmatchedHeaders: sheetPlan.unmatchedHeaders,
          sampleValues,
          columns:          sheetMeta.columns,
          detectedConcepts: sheetMeta.detectedConcepts,
          columnProfiles:   sheetMeta.columnProfiles,
        });
      }

      // Compute metadata and insights
      const allColumns = [...new Set(metaSheets.flatMap(s => s.columns || Object.keys(s.columnMap || {})))];
      const allConcepts = [...new Set(metaSheets.flatMap(s => s.detectedConcepts || []))];
      const allProfiles = metaSheets.flatMap(s => s.columnProfiles || []);

      const revenueSheet = metaSheets.find(s =>
        s.columnMap?.order_amount || s.columnMap?.price
      );
      const insights = {
        hasOrders:    metaSheets.some(s => s.columnMap?.order_id),
        hasProducts:  metaSheets.some(s => s.columnMap?.product_name),
        hasInventory: metaSheets.some(s => s.columnMap?.stock),
        hasPayments:  metaSheets.some(s => s.columnMap?.payment_method),
        totalRows:    insertedTotal,
        primarySheet: metaSheets[0]?.sheetName || null,
        revenueField: revenueSheet?.columnMap?.order_amount || revenueSheet?.columnMap?.price || null,
      };

      await db.saveDatasetMetadata(sessionId, datasetId, {
        columns:          allColumns,
        detectedConcepts: allConcepts,
        columnProfiles:   allProfiles,
        sheets:           metaSheets,
      });

      // Generate rich AI business insights using NVIDIA NIM Mixtral MoE
      const sampleRows = metaSheets[0]?.sampleValues || {};
      const aiInsights = await intelligence.generateDatasetInsights(plan.fileName, allColumns, sampleRows).catch(() => ({}));

      await db.saveDatasetInsights(sessionId, datasetId, {
        ...insights,
        aiInsights,
      });
      await db.updateDataset(datasetId, { rowCount: insertedTotal });

      // Finalize session
      session.uploadProgress.status   = 'done';
      session.uploadProgress.inserted = insertedTotal;
      session.pendingUploadPlan        = null;
      session.uploadDone               = true;
      session.pendingConfirmation      = false;
      session.activeFlow               = null;

      const hostUrl = (req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1'))
        ? `http://${req.get('host')}`
        : PUBLIC_URL;
      const dashboardUrl = `${hostUrl}/dashboard/${sessionId}`;
      const doneMsg = `🎉 Done! ${insertedTotal} rows saved across ${metaSheets.length} dataset(s).\n\n📊 Your live dashboard:\n${dashboardUrl}\n\nBookmark it — it refreshes every 10 seconds! 🚀`;
      session.messages.push({ role: 'bot', text: doneMsg, dashboardUrl, time: Date.now() });
      session.history.push({ role: 'model', parts: [{ text: doneMsg }] });
      persistSession(session);

      console.log(`✅ Streaming insert complete: ${insertedTotal} rows | session ${sessionId.slice(0,8)}`);

    } catch (err) {
      console.error('Streaming insert error:', err.message);
      session.uploadProgress.status = 'error';
      session.uploadProgress.error  = err.message;
      persistSession(session);
    }
  });
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/upload-status/:sessionId — Poll streaming insert progress ───────
app.get('/api/upload-status/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    const progress = session?.uploadProgress || { status: 'idle' };
    const hostUrl = (req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1'))
      ? `http://${req.get('host')}`
      : PUBLIC_URL;
    const dashboardUrl = progress.status === 'done'
      ? `${hostUrl}/dashboard/${req.params.sessionId}`
      : null;
    res.json({ ...progress, dashboardUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/metadata/:sessionId — LLM-ready business context ────────────────
app.get('/api/metadata/:sessionId', async (req, res) => {
  try {
    const meta    = await db.getUploadMetadata(req.params.sessionId);
    const context = await db.buildLLMContext(req.params.sessionId);
    res.json({ metadata: meta, llmContext: context });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /session/:sessionId/messages (restore chat history on page reload) ─────
app.get('/session/:sessionId/messages', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    res.json({ messages: session ? session.messages : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const datasetsList = await db.getDatasets(sessionId);
    const tableData = await db.getTableData(sessionId);

    console.log('📊 Dashboard debug - stats:', JSON.stringify(stats));
    console.log('📊 Dashboard debug - datasets:', datasetsList.length);
    
    res.send(renderDashboard(sessionId, stats, datasetsList, tableData));
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).send(`<pre style="color:red;padding:20px">❌ ${err.message}\n\nMake sure MongoDB is running.</pre>`);
  }
});

// ─── GET /api/stats/:sessionId (legacy) ──────────────────────────────────────
app.get('/api/stats/:sessionId', async (req, res) => {
  try {
    const stats = await db.getStats(req.params.sessionId);
    const data = await db.getTableData(req.params.sessionId);
    res.json({ stats, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: GET /api/dataset/:datasetId/metadata ───────────────────────────────
// Verify: Parser extracted schema correctly
app.get('/api/dataset/:datasetId/metadata', async (req, res) => {
  try {
    const { datasetId } = req.params;
    const merchantId = req.query.merchantId || req.query.sessionId;
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId or sessionId query parameter required' });
    }

    const db_conn = await db.connect();
    const [dataset, metadata] = await Promise.all([
      db_conn.collection('datasets').findOne({ _id: datasetId, merchantId }),
      db_conn.collection('dataset_metadata').findOne({ datasetId, merchantId }),
    ]);

    if (!dataset || !metadata) {
      return res.status(404).json({ error: 'Dataset or metadata not found' });
    }

    res.json({
      datasetId,
      fileName: dataset.fileName,
      uploadedAt: dataset.uploadedAt,
      rowCount: dataset.rowCount,
      columnCount: dataset.columnCount,
      sheetNames: dataset.sheetNames || [],
      columns: metadata.columns || [],
      columnMap: metadata.columnMap || {},
      detectedConcepts: metadata.detectedConcepts || [],
      sheets: metadata.sheets || [],
      columnProfiles: metadata.columnProfiles || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: GET /api/dataset/:datasetId/insights ────────────────────────────────
// Verify: Insight generation working
app.get('/api/dataset/:datasetId/insights', async (req, res) => {
  try {
    const { datasetId } = req.params;
    const merchantId = req.query.merchantId || req.query.sessionId;
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId or sessionId query parameter required' });
    }

    const db_conn = await db.connect();
    const [dataset, insightsDoc] = await Promise.all([
      db_conn.collection('datasets').findOne({ _id: datasetId, merchantId }),
      db_conn.collection('dataset_insights').findOne({ datasetId, merchantId }),
    ]);

    if (!dataset) {
      return res.status(404).json({ error: 'Dataset not found' });
    }

    const insights = insightsDoc?.insights || {};
    
    res.json({
      datasetId,
      fileName: dataset.fileName,
      totalRows: dataset.rowCount || 0,
      generatedAt: insightsDoc?.generatedAt || 'Not generated',
      insights,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: GET /api/dataset/:datasetId/records ──────────────────────────────────
// Verify: Raw records stored correctly
app.get('/api/dataset/:datasetId/records', async (req, res) => {
  try {
    const { datasetId } = req.params;
    const merchantId = req.query.merchantId || req.query.sessionId;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const skip = parseInt(req.query.skip) || 0;

    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId or sessionId query parameter required' });
    }

    const db_conn = await db.connect();
    const [totalCount, records] = await Promise.all([
      db_conn.collection('dataset_records').countDocuments({ merchantId, datasetId }),
      db_conn.collection('dataset_records')
        .find({ merchantId, datasetId })
        .sort({ sheetName: 1, rowNumber: 1 })
        .skip(skip)
        .limit(limit)
        .project({ merchantId: 0, _id: 0 })
        .toArray(),
    ]);

    // Extract columns from first record
    const columns = records.length > 0 ? Object.keys(records[0].data || {}) : [];

    res.json({
      datasetId,
      totalRows: totalCount,
      recordsReturned: records.length,
      skip,
      limit,
      columns,
      records: records.map(r => ({
        sheetName: r.sheetName,
        rowNumber: r.rowNumber,
        data: r.data,
        uploadedAt: r.uploadedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: GET /api/datasets/:merchantId ────────────────────────────────────
// Returns all datasets for a merchant with metadata and basic stats
app.get('/api/datasets/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params;
    const datasets = await db.getDatasets(merchantId);
    const result = datasets.map(d => ({
      datasetId: d._id,
      fileName: d.fileName,
      sheetNames: d.sheetNames || [],
      rowCount: d.rowCount || 0,
      columnCount: d.columnCount || 0,
      uploadedAt: d.uploadedAt,
      status: d.status,
    }));
    res.json({ datasets: result, count: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: GET /api/dataset/:datasetId ──────────────────────────────────────
// Returns complete dataset bundle: metadata, records, and insights
app.get('/api/dataset/:datasetId', async (req, res) => {
  try {
    const { datasetId } = req.params;
    // Extract merchantId from query or use sessionId as merchantId (backward compat)
    const merchantId = req.query.merchantId || req.query.sessionId;
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId or sessionId query parameter required' });
    }

    const bundle = await db.getDatasetBundle(merchantId, datasetId, 1200);
    if (!bundle) {
      return res.status(404).json({ error: 'Dataset not found' });
    }

    res.json({
      dataset: {
        id: bundle.dataset._id,
        fileName: bundle.dataset.fileName,
        sheetNames: bundle.dataset.sheetNames,
        rowCount: bundle.dataset.rowCount,
        columnCount: bundle.dataset.columnCount,
        uploadedAt: bundle.dataset.uploadedAt,
      },
      metadata: {
        columns: bundle.metadata?.columns || [],
        detectedConcepts: bundle.metadata?.detectedConcepts || [],
        sheets: bundle.metadata?.sheets || [],
      },
      insights: bundle.insights || {},
      records: bundle.records || [],
      recordCount: (bundle.records || []).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEMPORARY TEST ROUTE: GET /api/test-insights ───────────────────────────
app.get('/api/test-insights', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const parser = require('./parser');
    const intelligence = require('./intelligence');

    const filePath = path.join(__dirname, 'research', '04 Restaurant Sales.xlsx');
    console.log(`[TEST-INSIGHTS] Reading file: ${filePath}`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }
    const buffer = fs.readFileSync(filePath);
    const plan = parser.detectSheetsAndColumns(buffer);
    
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = plan.sheets[0]?.sheetName;
    if (!firstSheetName) {
      return res.status(400).json({ error: 'No sheets found in sample file' });
    }
    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    
    const allColumns = plan.columns;
    const sampleRows = rows.slice(0, 3);
    
    console.log('[TEST-INSIGHTS] Invoking generateDatasetInsights with NVIDIA NIM...');
    const result = await intelligence.generateDatasetInsights('04 Restaurant Sales.xlsx', allColumns, sampleRows);
    console.log('[TEST-INSIGHTS] Results returned:', result);
    
    // Direct test of NIM connection to diagnose any failures
    let nimDirectResult = null;
    let nimTestError = null;
    let nimModels = [];
    try {
      const axios = require('axios');
      const modelsRes = await axios.get('https://integrate.api.nvidia.com/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.NIM_KEY}` }
      });
      nimModels = modelsRes.data?.data?.map(m => m.id) || [];
    } catch (e) {
      console.error('Failed to fetch NIM models:', e.message);
    }

    try {
      nimDirectResult = await intelligence.callNvidiaNIM(
        [{ role: 'user', content: 'Hello, respond with ONLY the word "SUCCESS"' }],
        'Test system prompt'
      );
    } catch (e) {
      nimTestError = {
        message: e.message,
        response: e.response?.data || null,
        status: e.response?.status || null
      };
    }

    res.json({
      success: true,
      fileAnalyzed: '04 Restaurant Sales.xlsx',
      columns: allColumns,
      sampleRowsSent: sampleRows,
      aiResult: result,
      nimDirectResult,
      nimTestError,
      nimModels,
    });
  } catch (err) {
    console.error('[TEST-INSIGHTS] Error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ─── NEW: POST /api/query/:datasetId ───────────────────────────────────────
// Execute a structured query plan on a dataset
app.post('/api/query/:datasetId', async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { queryPlan, merchantId, sessionId } = req.body;
    const actualMerchantId = merchantId || sessionId;
    
    if (!actualMerchantId) {
      return res.status(400).json({ error: 'merchantId or sessionId required' });
    }
    if (!queryPlan) {
      return res.status(400).json({ error: 'queryPlan required in body' });
    }

    const result = await db.executeQueryPlan(actualMerchantId, datasetId, queryPlan);
    res.json({ queryPlan, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard HTML — Data Observability Tool ──────────────────────────────────
// Purpose: Verify the entire data pipeline is working correctly.
// Tabs: Metadata (parser output) | Insights (generated metrics) | Records (raw data)
function renderDashboard(sessionId, stats, datasetsList, tableData) {
  const datasets = datasetsList || [];
  const sheets = tableData.sheets || [];

  const fileItemsHtml = datasets.map((d, idx) => {
    const activeClass = idx === 0 ? 'active' : '';
    const dateStr = new Date(d.uploadedAt).toLocaleString();
    return `
      <div class="file-item ${activeClass}" data-id="${d._id}" onclick="selectDataset('${d._id}')">
        <div class="file-name">${d.fileName}</div>
        <div class="file-meta">
          <span>Rows: ${d.rowCount || 0}</span> • <span>Cols: ${d.columnCount || 0}</span>
          <br>
          <span style="font-size: 0.75rem; color: var(--muted);">${dateStr}</span>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ShopBot Data Inspector</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0e1a;
      --surface: #111827;
      --card: #1a2235;
      --border: #243047;
      --accent: #25d366;
      --text: #f0f4ff;
      --muted: #8899bb;
      --error: #ff6b6b;
      --warn: #ffa502;
      --success: #51cf66;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: linear-gradient(135deg, #0d1f1a, #1a3a2e);
      border-bottom: 1px solid var(--border);
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 70px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-icon {
      font-size: 1.8rem;
    }
    .logo h1 {
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .logo p {
      font-size: 0.75rem;
      color: var(--muted);
    }
    .live-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(37, 211, 102, 0.1);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .live-dot {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.6; }
    }
    
    .dashboard-layout {
      display: flex;
      flex: 1;
      height: calc(100vh - 70px);
      overflow: hidden;
    }
    
    .sidebar {
      width: 320px;
      background: #0f172a;
      border-right: 1px solid var(--border);
      padding: 24px;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    
    .sidebar-title {
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 1px;
      margin-bottom: 16px;
    }
    
    .file-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .file-item {
      padding: 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .file-item:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    
    .file-item.active {
      border-color: var(--accent);
      background: rgba(37, 211, 102, 0.05);
      box-shadow: 0 4px 12px rgba(37, 211, 102, 0.1);
    }
    
    .file-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--text);
      margin-bottom: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .file-meta {
      font-size: 0.8rem;
      color: var(--muted);
      line-height: 1.4;
    }
    
    .main-panel {
      flex: 1;
      padding: 32px;
      overflow-y: auto;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    
    .main-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    .main-header-info h2 {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text);
    }
    
    .main-header-info p {
      font-size: 0.85rem;
      color: var(--muted);
      margin-top: 4px;
    }
    
    .back-btn {
      display: inline-flex;
      align-items: center;
      background: rgba(240, 244, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    .back-btn:hover {
      background: rgba(240, 244, 255, 0.1);
      border-color: var(--muted);
    }
    
    .tab-nav {
      display: flex;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1px;
    }
    
    .tab-btn {
      background: none;
      border: none;
      color: var(--muted);
      padding: 12px 24px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab-btn:hover {
      color: var(--text);
    }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
    }
    
    .section-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .info-box {
      background: rgba(10, 14, 26, 0.5);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .info-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.9rem;
    }
    
    .info-label {
      color: var(--muted);
      font-weight: 500;
    }
    
    .info-value {
      color: var(--text);
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }
    
    .metadata-card {
      background: rgba(10, 14, 26, 0.3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .metadata-card-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .metadata-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      margin-bottom: 8px;
    }
    .metadata-label {
      color: var(--muted);
    }
    .metadata-value {
      color: var(--text);
      font-weight: 500;
    }
    
    .insights-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    
    .insight-card {
      background: rgba(10, 14, 26, 0.3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 120px;
    }
    
    .insight-label {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.5px;
    }
    
    .insight-value {
      font-size: 1.8rem;
      font-weight: 700;
      color: var(--text);
      margin: 12px 0 4px 0;
    }
    
    .insight-note {
      font-size: 0.75rem;
      color: var(--muted);
    }
    
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-ok {
      background: rgba(81, 207, 102, 0.15);
      color: var(--success);
      border: 1px solid rgba(81, 207, 102, 0.3);
    }
    
    .records-table {
      overflow-x: auto;
      max-height: 500px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      text-align: left;
    }
    
    th {
      background: #0f172a;
      color: var(--muted);
      padding: 12px 16px;
      font-weight: 600;
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    tr:hover td {
      background: rgba(240, 244, 255, 0.02);
    }
    
    .no-data {
      text-align: center;
      padding: 40px;
      color: var(--muted);
      font-style: italic;
    }
    
    .sheet-tab-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 8px 16px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.2s;
    }
    .sheet-tab-btn:hover {
      color: var(--text);
      background: rgba(240, 244, 255, 0.02);
    }
    .sheet-tab-btn.active {
      color: var(--accent);
      background: rgba(37, 211, 102, 0.1);
    }
  </style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">🔍</div>
    <div>
      <h1>Data Inspector</h1>
      <p>Pipeline verification tool • Session: ${sessionId.substring(0, 12)}...</p>
    </div>
  </div>
  <div class="live-badge"><div class="live-dot"></div>OBSERVING</div>
</header>

<div class="dashboard-layout">
  <!-- SIDEBAR: LIST OF FILES -->
  <div class="sidebar">
    <div class="sidebar-title">📁 Uploaded Files</div>
    <div class="file-list">
      ${fileItemsHtml || '<div class="no-data">No uploads found</div>'}
    </div>
  </div>
  
  <!-- MAIN WORKSPACE -->
  <div class="main-panel">
    <div class="main-header">
      <div class="main-header-info">
        <h2 id="current-file-name">Select a file</h2>
        <p>Uploaded: <span id="current-file-date">N/A</span></p>
      </div>
      <a href="/" class="back-btn">← Back to Chat</a>
    </div>
    
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchTab('metadata')">📋 Metadata</button>
      <button class="tab-btn" onclick="switchTab('insights')">📊 Insights</button>
      <button class="tab-btn" onclick="switchTab('records')">📄 Records</button>
    </div>
    
    <!-- METADATA TAB -->
    <div id="metadata" class="tab-content active">
      <div id="metadata-tab-content">
        <div class="no-data">Select a file from the sidebar to inspect its metadata.</div>
      </div>
    </div>
    
    <!-- INSIGHTS TAB -->
    <div id="insights" class="tab-content">
      <div id="insights-tab-content">
        <div class="no-data">Select a file from the sidebar to inspect its insights.</div>
      </div>
    </div>
    
    <!-- RECORDS TAB -->
    <div id="records" class="tab-content">
      <div id="records-tab-content">
        <div class="no-data">Select a file from the sidebar to inspect its records.</div>
      </div>
    </div>
  </div>
</div>

<script>
  // Embed datasets and sheet records directly as JSON
  const datasetsList = ${JSON.stringify(datasets)};
  const sheetsData = ${JSON.stringify(sheets)};
  
  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
    event.target.classList.add('active');
  }
  
  function switchSheetTab(sheetName, btn) {
    const container = btn.closest('.section');
    container.querySelectorAll('.sheet-tab-btn').forEach(el => el.classList.remove('active'));
    container.querySelectorAll('.sheet-table-content').forEach(el => {
      el.classList.remove('active');
      el.style.display = 'none';
    });
    
    btn.classList.add('active');
    const target = document.getElementById('sheet-table-' + sheetName);
    if (target) {
      target.classList.add('active');
      target.style.display = 'block';
    }
  }
  
  function renderMetadataTab(dataset) {
    const meta = dataset.metadata || {};
    const sheets = meta.sheets || [];
    
    let html = '';
    if (sheets.length === 0) {
      html = '<div class="no-data">No sheets metadata found</div>';
    } else {
      html = \`
        <div class="section">
          <div class="section-title">📋 Dataset Profile</div>
          <div class="info-box">
            <div class="info-row"><span class="info-label">File Name:</span><span class="info-value">\${dataset.fileName}</span></div>
            <div class="info-row"><span class="info-label">Total Sheets:</span><span class="info-value">\${sheets.length}</span></div>
            <div class="info-row"><span class="info-label">Total Rows:</span><span class="info-value">\${dataset.rowCount || 0}</span></div>
            <div class="info-row"><span class="info-label">Total Columns:</span><span class="info-value">\${dataset.columnCount || 0}</span></div>
          </div>
        </div>
        
        <div class="section" style="margin-top: 24px;">
          <div class="section-title">🗂️ Sheet Breakdown</div>
      \`;
      
      html += sheets.map((s, i) => {
        const colList = (s.columns || []).slice(0, 5).join(', ');
        const hasMore = (s.columns?.length || 0) > 5 ? '...' : '';
        return \`
          <div class="metadata-card" style="margin-bottom: 16px;">
            <div class="metadata-card-title">Sheet \${i + 1}: \${s.sheetName}</div>
            <div class="metadata-row"><span class="metadata-label">Type:</span><span class="metadata-value">\${s.semanticType || 'dataset'}</span></div>
            <div class="metadata-row"><span class="metadata-label">Rows:</span><span class="metadata-value">\${s.rowCount}</span></div>
            <div class="metadata-row"><span class="metadata-label">Columns:</span><span class="metadata-value">\${s.columns?.length || 0}</span></div>
            <div class="metadata-row"><span class="metadata-label">Detected Fields:</span><span class="metadata-value">\${colList}\${hasMore}</span></div>
          </div>
        \`;
      }).join('') + '</div>';
    }
    document.getElementById('metadata-tab-content').innerHTML = html;
  }
  
  function renderInsightsTab(dataset) {
    const insights = dataset.insights || {};
    const aiInsights = insights.aiInsights || {};
    
    let description = 'No description generated yet.';
    let insightsList = [];
    
    if (aiInsights && typeof aiInsights === 'object') {
      if (aiInsights.description) {
        description = aiInsights.description;
      }
      
      if (Array.isArray(aiInsights.insights)) {
        insightsList = aiInsights.insights;
      } else {
        // Fallback for old format: extract all key-value entries as list
        insightsList = Object.entries(aiInsights)
          .filter(([key]) => key !== 'description' && key !== 'insights' && key !== 'lastUpdated')
          .map(([_, val]) => val);
          
        if (!aiInsights.description && insightsList.length > 0) {
          description = 'This dataset has ' + (dataset.columnCount || 0) + ' fields and contains ' + (dataset.rowCount || 0) + ' records. AI has scanned the structure and generated the following insights:';
        }
      }
    }
    
    let html = \`
      <div class="section">
        <div class="section-title">📝 File Description & Context</div>
        <div class="info-box" style="background: rgba(37, 211, 102, 0.05); border: 1px solid rgba(37, 211, 102, 0.3); padding: 20px; border-radius: 8px;">
          <p style="font-size: 1rem; line-height: 1.6; color: var(--text); font-weight: 500; margin: 0;">
            \${description}
          </p>
        </div>
      </div>

      <div class="section" style="margin-top: 24px;">
        <div class="section-title">📊 Dataset Statistics</div>
        <div class="insights-grid">
          <div class="insight-card">
            <div class="insight-label">Rows</div>
            <div class="insight-value">\${dataset.rowCount || 0}</div>
            <div class="insight-note">Total records in file</div>
          </div>
          <div class="insight-card">
            <div class="insight-label">Columns</div>
            <div class="insight-value">\${dataset.columnCount || 0}</div>
            <div class="insight-note">Detected data fields</div>
          </div>
          <div class="insight-card">
            <div class="insight-label">Status</div>
            <div class="insight-value"><span class="status-badge status-ok">Analyzed</span></div>
            <div class="insight-note">Pipeline complete</div>
          </div>
        </div>
      </div>
    \`;
    
    let aiInsightsHtml = '';
    if (insightsList.length > 0) {
      aiInsightsHtml = insightsList.map((val) => \`
        <div class="insight-card ai-card" style="grid-column: span 3; background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid var(--accent);">
          <div class="insight-label" style="color: var(--accent); font-weight: 600;">💡 AI Business Insight</div>
          <div class="insight-value" style="font-size: 0.95rem; font-weight: 500; color: var(--text); line-height: 1.4; margin-top: 8px;">
            \${val}
          </div>
        </div>
      \`).join('');
    } else {
      aiInsightsHtml = \`
        <div class="insight-card" style="grid-column: span 3;">
          <div class="insight-label">AI Insights</div>
          <div class="insight-value" style="font-size: 0.9rem; color: var(--muted); margin-top: 8px;">
            No AI insights generated yet. Insights are computed at upload time.
          </div>
        </div>
      \`;
    }
    
    html += \`
      <div class="section" style="margin-top: 24px;">
        <div class="section-title">💡 Generated Business Intelligence</div>
        <div class="insights-grid">
          \${aiInsightsHtml}
        </div>
      </div>
    \`;
    
    document.getElementById('insights-tab-content').innerHTML = html;
  }
  
  function renderRecordsTab(dataset) {
    const datasetSheets = sheetsData.filter(s => s.datasetId === dataset._id);
    
    let html = '';
    if (datasetSheets.length === 0) {
      html = '<div class="no-data">No records stored for this dataset</div>';
    } else {
      let sheetSelectors = '';
      if (datasetSheets.length > 1) {
        sheetSelectors = \`
          <div class="sheet-nav" style="display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            \${datasetSheets.map((s, idx) => \`
              <button class="sheet-tab-btn \${idx === 0 ? 'active' : ''}" onclick="switchSheetTab('\${s.name}', this)">
                \${s.name}
              </button>
            \`).join('')}
          </div>
        \`;
      }
      
      const tablesHtml = datasetSheets.map((s, idx) => {
        const rows = s.rows || [];
        if (rows.length === 0) {
          return \`<div id="sheet-table-\${s.name}" class="sheet-table-content \${idx === 0 ? 'active' : ''}" style="display: \${idx === 0 ? 'block' : 'none'};"><div class="no-data">No rows in this sheet</div></div>\`;
        }
        
        const cols = s.columns || Object.keys(rows[0] || {});
        const headerHtml = cols.map(col => \`<th>\${String(col).substring(0, 20)}</th>\`).join('');
        const bodyHtml = rows.map(row => {
          const cells = cols.map(col => \`<td>\${String(row[col] || '').substring(0, 50)}</td>\`).join('');
          return \`<tr>\${cells}</tr>\`;
        }).join('');
        
        return \`
          <div id="sheet-table-\${s.name}" class="sheet-table-content \${idx === 0 ? 'active' : ''}" style="display: \${idx === 0 ? 'block' : 'none'};">
            <div class="info-box" style="margin-bottom: 16px;">
              <div class="info-row">
                <span class="info-label">Showing:</span>
                <span class="info-value">First 1000 records of "\${s.name}"</span>
              </div>
              <div class="info-row">
                <span class="info-label">Total Records:</span>
                <span class="info-value">\${rows.length}</span>
              </div>
            </div>
            <div class="records-table">
              <table>
                <thead><tr>\${headerHtml}</tr></thead>
                <tbody>\${bodyHtml}</tbody>
              </table>
            </div>
          </div>
        \`;
      }).join('');
      
      html = \`
        <div class="section">
          <div class="section-title">📄 Raw Data Storage Verification</div>
          \${sheetSelectors}
          \${tablesHtml}
        </div>
      \`;
    }
    document.getElementById('records-tab-content').innerHTML = html;
  }
  
  function selectDataset(datasetId) {
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-id') === datasetId);
    });
    
    const dataset = datasetsList.find(d => d._id === datasetId);
    if (!dataset) return;
    
    document.getElementById('current-file-name').innerText = dataset.fileName;
    document.getElementById('current-file-date').innerText = new Date(dataset.uploadedAt).toLocaleString();
    
    renderMetadataTab(dataset);
    renderInsightsTab(dataset);
    renderRecordsTab(dataset);
  }
  
  // Initialize with first dataset
  if (datasetsList.length > 0) {
    selectDataset(datasetsList[0]._id);
  } else {
    document.getElementById('current-file-name').innerText = 'No files uploaded';
  }
</script>
</body>
</html>`;
}

// ─── Admin: missed-intents review queue ──────────────────────────────────────
// All routes require the X-Admin-Secret header matching ADMIN_SECRET env var.
// If ADMIN_SECRET is not set, the endpoints are disabled (503).

function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin endpoint not configured. Set ADMIN_SECRET env var.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/missed-intents?resolved=false&limit=50&intent=CLARIFICATION
app.get('/api/missed-intents', adminAuth, async (req, res) => {
  try {
    const resolved = req.query.resolved !== undefined
      ? req.query.resolved === 'true'
      : undefined;
    const docs = await getMissedIntents({
      resolved,
      sessionId: req.query.sessionId,
      intent:    req.query.intent,
      limit:     parseInt(req.query.limit)  || 50,
      skip:      parseInt(req.query.skip)   || 0,
    });
    res.json({ count: docs.length, items: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/missed-intents/stats
app.get('/api/missed-intents/stats', adminAuth, async (req, res) => {
  try {
    const stats = await getMissedIntentStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/missed-intents/:id  { "correct_intent": "DATA_ANALYTICS" }
app.patch('/api/missed-intents/:id', adminAuth, async (req, res) => {
  try {
    const { correct_intent } = req.body;
    const ok = await resolveMissedIntent(req.params.id, correct_intent);
    if (!ok) return res.status(404).json({ error: 'Document not found or already resolved' });
    res.json({ success: true, id: req.params.id, correct_intent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  // Test NVIDIA NIM Connection on Startup
  (async () => {
    try {
      console.log('⚡ [STARTUP-TEST] Testing connection to NVIDIA NIM (minimaxai/minimax-m2.7)...');
      const testRes = await require('./intelligence').callNvidiaNIM(
        [{ role: 'user', content: 'Respond with ONLY the word "READY"' }],
        'Test system prompt'
      );
      console.log(`✅ [STARTUP-TEST] NIM Connection Successful! Response: "${testRes.trim()}"`);
    } catch (err) {
      console.error('❌ [STARTUP-TEST] NIM Connection Failed:', err.message);
      if (err.response) {
        console.error('   Error Data:', JSON.stringify(err.response.data));
      }
    }
  })();

  // Start WhatsApp if enabled
  if (process.env.WHATSAPP_ENABLED === 'true') {
    const { initWhatsApp } = require('./whatsapp');
    initWhatsApp();
  }
});
