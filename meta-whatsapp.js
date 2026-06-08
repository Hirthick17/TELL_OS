// meta-whatsapp.js — Official Meta WhatsApp Cloud API integration
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// LLM logic and session store are shared via llm.js and sessions.js

require('dotenv').config();
const axios                  = require('axios');
const path                   = require('path');
const { parseExcel, streamSheet, extractSamples, buildSheetMetadata } = require('./parser');
const db                     = require('./db');
const { chat, friendlyLLMError } = require('./llm');
const { getSessionByPhone, persistSession } = require('./sessions');
const intelligence           = require('./intelligence');
const {
  routePathway,
  resolveAnalyticsIntent,
  formatAnalyticsReply,
} = require('./intent-router');
const { classifyIntent } = require('./intent-classifier');
const {
  storeMissedIntent,
  backfillCorrectIntent,
} = require('./missed-intents');

// ─── REMOVED: Old ERP INTENT_TO_QUERY mapping ───────────────────────────────
// The system is now fully flexible and dataset-centric. No more hardcoded
// product/order/inventory/payment queries. All analytics are driven by
// dynamically detected dataset metadata and user questions.


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
async function handleFileMessage(waId, mediaId, filename, hostUrl) {
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

    // New parser stores everything in sheetSummary, not in typed arrays
    for (const sheet of parsed.sheetSummary) {
      const EMOJI = { orders: '🛒', products: '📦', inventory: '🏪', payments: '💳', dataset: '📄' };
      const emoji = EMOJI[sheet.type] || '📄';
      lines.push(`${emoji} *${sheet.rowCount} rows* in "${sheet.sheetName}"`);
    }

    if (lines.length === 0 || parsed.sheetSummary.every(s => s.rowCount === 0)) {
      await sendMessage(waId, '❌ No readable data...');
      return;
    }

    session.pendingPreview = {
      sheetSummary: parsed.sheetSummary,
      rawRows: parsed.unknown,
      fileName: filename,
      fileBuffer: buffer.toString('base64'),
      hostUrl: hostUrl,
      products: [], orders: [], inventory: [], payments: [],
    };
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
async function handleTextMessage(waId, text, hostUrl) {
  const session = await getSessionByPhone(waId);

  // Sync derived flags so Layer 1 gates work correctly
  session.pendingConfirmation = !!session.pendingPreview;
  if (session.pendingPreview || session.awaitingUpload) session.activeFlow = 'data_entry';

  // ── STEP 1: Hard safety + onboarding gates (fast, no LLM) ────────────
  const pathway = await routePathway(text, session);
  console.log(`🧭 [WA] Route: ${pathway.route} (confident=${pathway.confident}) | ${waId}`);

  // ── SAFETY BLOCK ─────────────────────────────────────────
  if (pathway.route === 'safety_block') {
    return sendMessage(waId, `⚠️ That action isn't available through chat. Please contact support if you need to reset your data.`);
  }

  // ── ONBOARDING (help request/greetings) ───────────────────────────────
  if (pathway.route === 'onboarding') {
    const ctx = session.uploadDone
      ? `[Context: Data uploaded. Dashboard: ${PUBLIC_URL}/dashboard/${session.sessionId}. Explain analytics features.]`
      : `[Context: User asking for help. Explain ShopBot — Excel upload, live dashboard, AI analytics.]`;
    try {
      session.history.push({ role: 'user', parts: [{ text }] });
      const reply = await chat(text, session.history.slice(0, -1), ctx);
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      persistSession(session);
      return sendMessage(waId, reply);
    } catch (err) {
      return sendMessage(waId, friendlyLLMError(err));
    }
  }

  // ── STEP 2: Gemini JSON intent classifier ─────────────────────────────
  const skipClassifier = pathway.route !== 'pass_to_classifier';
  let classification;

  if (skipClassifier) {
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
    classification = await classifyIntent(text, {}, session);
    console.log(`🎯 [WA] Classified: ${classification.intent} (${classification.confidence.toFixed(2)}) fallback=${classification.fallback_used} | ${waId}`);
  }

  // ── STEP 3: Threshold gate ─────────────────────────────────────────────
  if (classification.fallback_used && classification.route !== 'clarification') {
    classification.confidence = 0.85; // treat fallback route as high-confidence
  }

  const { intent, confidence, conflict } = classification;
  const THRESHOLD_ROUTE  = 0.80;
  const THRESHOLD_LOG    = 0.65;

  // Conflict → always clarification regardless of confidence
  if (conflict && !skipClassifier) {
    const clarifyReply = `🤔 I see two possible things you need — ${classification.conflict_note || 'your request had mixed signals'}\n\nCould you clarify?\n📊 If you want to *see* your data — ask "show my revenue" or "what's my stock"\n📂 If you want to *update* data — say "fix the price" or "upload new file"`;
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: clarifyReply }] });
    persistSession(session);
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp' },
      returned_intent:  intent,
      confidence,
      signals_detected: classification.signals_detected,
      conflict:         true,
      conflict_note:    classification.conflict_note,
      session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: session.sessionId },
      reason:           'conflict',
    }).catch(() => {});
    return sendMessage(waId, clarifyReply);
  }

  // Low confidence → clarification + log
  if (confidence < THRESHOLD_LOG && !skipClassifier) {
    const clarifyReply = `I didn't quite catch that. Did you want to:\n\n*1.* 📊 Check your analytics — orders, stock, revenue\n*2.* 📂 Upload or update your data\n*3.* ❓ Something else\n\nJust reply with a number or rephrase your question!`;
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: clarifyReply }] });
    persistSession(session);
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp' },
      returned_intent:  intent,
      confidence,
      signals_detected: classification.signals_detected,
      conflict:         false,
      conflict_note:    '',
      session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: session.sessionId },
      reason:           'low_confidence',
    }).catch(() => {});
    return sendMessage(waId, clarifyReply);
  }

  // Medium confidence (0.65–0.79) → route but log for review
  if (confidence < THRESHOLD_ROUTE && !skipClassifier) {
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp' },
      returned_intent:  intent,
      confidence,
      signals_detected: classification.signals_detected,
      conflict:         false,
      conflict_note:    '',
      session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: session.sessionId },
      reason:           'medium_confidence',
    }).catch(() => {});
  }

  // High confidence → backfill any previous unresolved intent for this session
  if (confidence >= THRESHOLD_ROUTE && !skipClassifier && session.lastClassifiedIntent) {
    backfillCorrectIntent(session.sessionId, intent, text).catch(() => {});
  }

  // Update session with this classification
  session.lastClassifiedIntent = intent;
  session.lastRoute             = classification.route;
  session.activeFlow            = classification.route === 'data_analytics' ? 'data_analytics' : 'data_entry';
  session.recentRoutes          = [...(session.recentRoutes || []).slice(-4), classification.route];

  // ── STEP 4: Route to the correct pathway ──────────────────────────────
  const effectiveRoute = classification.route;

  if (effectiveRoute === 'clarification') {
    const clarifyReply = `I couldn't quite understand that. Could you try rephrasing?`;
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: clarifyReply }] });
    persistSession(session);
    return sendMessage(waId, clarifyReply);
  }

  if (effectiveRoute === 'data_analytics') {
    // NEW: Flexible analytics pathway - with Query Planner execution
    const metaCtx = await db.buildLLMContext(session.sessionId).catch(() => null);
    const stats = await db.getStats(session.sessionId).catch(() => null);
    const datasetId = stats?.latestDatasetId;
    let queryResult = null;
    let queryPlan = null;
    let executed = false;

    if (datasetId) {
      const db_conn = await db.connect();
      const metadata = await db_conn.collection('dataset_metadata').findOne({ datasetId }).catch(() => null);
      if (metadata) {
        try {
          queryPlan = await intelligence.buildQueryPlan(text, datasetId, metadata);
          if (queryPlan && queryPlan.operation === 'aggregate' && queryPlan.field) {
            queryResult = await db.executeQueryPlan(session.sessionId, datasetId, queryPlan);
            executed = true;
          }
        } catch (planErr) {
          console.warn('[WA] Intelligence query execution failed:', planErr.message);
        }
      }
    }

    let responseContext = `[Context: You are ShopBot, a WhatsApp commerce assistant. The user asked: "${text}".`;
    if (executed && queryResult) {
      responseContext += ` We ran a database query plan: ${JSON.stringify(queryPlan)} and got the results: ${JSON.stringify(queryResult)}.`;
      responseContext += ` Formulate a concise, friendly WhatsApp reply (short, with emojis) presenting this exact database result to the user.`;
    } else {
      responseContext += metaCtx 
        ? ` Answer their analytics question DIRECTLY using the data context below:\n\nAvailable Merchant Datasets:\n${metaCtx}`
        : ` Answer their analytics question based on the actual data structure, not assumptions.`;
    }
    responseContext += ` Be concise and WhatsApp-friendly (short, use emojis, no markdown). Never assume business categories or ERP structures. Answer based on what's actually in the query plan or data.]`;

    try {
      session.history.push({ role: 'user', parts: [{ text }] });
      const reply = await chat(text, session.history.slice(0, -1), responseContext);
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      persistSession(session);
      console.log(`📊 [WA] Flexible Analytics: ${waId}`);
      return sendMessage(waId, reply);
    } catch (err) {
      return sendMessage(waId, friendlyLLMError(err));
    }
  }

  // ── DATA ENTRY PATHWAY (original flow, preserved) ─────────────────
  const lower = text.toLowerCase();
  const YES = /\b(yes|store|save|confirm|proceed|sure|yeah|yep|ha|haan|okay)\b/i;
  const NO  = /\b(no|cancel|nope|nahi|nah|stop)\b/i;

  if (NO.test(lower)) {
    session.pendingPreview      = null;
    session.pendingConfirmation = false;
    const reply = `No problem! 😊 Upload a different file or let me know how I can help.`;
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    persistSession(session);
    return sendMessage(waId, reply);
  }

  // YES handler for pending file confirmation → save using new dataset flow
  if (session.pendingPreview && YES.test(lower)) {
    const p = session.pendingPreview;
    try {
      const fileBuffer = Buffer.from(p.fileBuffer, 'base64');
      const knownSheets = p.sheetSummary.filter(s => s.type !== 'unknown');

      const { datasetId } = await db.prepareUploadSession(
        session.sessionId,
        p.fileName,
        knownSheets
      );

      const metaSheets = [];
      let insertedTotal = 0;

      for (const sheetPlan of knownSheets) {
        let sheetRows = 0;
        let firstBatchRows = null;

        let startRow = 1;
        await streamSheet(fileBuffer, sheetPlan.sheetName, async (batch) => {
          await db.insertDatasetRecordsBatch(
            session.sessionId,
            datasetId,
            sheetPlan.sheetName,
            batch,
            startRow
          );
          startRow += batch.length;
          sheetRows += batch.length;
          insertedTotal += batch.length;
          if (!firstBatchRows) firstBatchRows = batch;
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

      await db.saveDatasetMetadata(session.sessionId, datasetId, {
        columns:          allColumns,
        detectedConcepts: allConcepts,
        columnProfiles:   allProfiles,
        sheets:           metaSheets,
      });

      // Generate rich AI business insights using NVIDIA NIM Mixtral MoE
      const sampleRows = metaSheets[0]?.sampleValues || {};
      const aiInsights = await intelligence.generateDatasetInsights(p.fileName, allColumns, sampleRows).catch(() => ({}));

      await db.saveDatasetInsights(session.sessionId, datasetId, {
        ...insights,
        aiInsights,
      });
      await db.updateDataset(datasetId, { rowCount: insertedTotal });

      session.uploadDone = true;
      session.pendingPreview = null;
      session.pendingConfirmation = false;
      session.activeFlow = null;

      const currentHostUrl = p.hostUrl || hostUrl || PUBLIC_URL;
      const dashboardUrl = `${currentHostUrl}/dashboard/${session.sessionId}`;
      const reply = `🎉 Done! ${insertedTotal} rows saved across ${metaSheets.length} sheet(s).\n\n📊 Your live dashboard:\n${dashboardUrl}`;
      
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      persistSession(session);
      return sendMessage(waId, reply);

    } catch (err) {
      console.error('WhatsApp save error:', err.message);
      return sendMessage(waId, `❌ Could not save data: ${err.message}`);
    }
  }

  // Service activation confirmation (legacy path for already uploaded data)
  if (session.uploadDone && YES.test(lower)) {
    session.confirmed = true;
    await db.confirmSession(session.sessionId).catch(() => {});
  }

  // Regular Gemini chat (data entry / onboarding)
  let contextNote = '';
  if (session.uploadDone) {
    const currentHostUrl = hostUrl || PUBLIC_URL;
    contextNote = `[Context: Data already stored. Dashboard: ${currentHostUrl}/dashboard/${session.sessionId}. Do NOT ask them to upload again.]`;
  } else if (session.awaitingUpload) {
    contextNote = '[Context: Already asked user to send Excel file. Gently remind them to attach .xlsx file.]';
  } else if (session.pendingPreview) {
    contextNote = '[Context: User sent a file, waiting for Yes/No confirmation to store it.]';
  }

  try {
    session.history.push({ role: 'user', parts: [{ text }] });
    const reply = await chat(text, session.history.slice(0, -1), contextNote);
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    if (/upload|excel|xlsx|file|attach|spreadsheet/i.test(reply)) {
      session.awaitingUpload = true;
    }

    // Always persist after every exchange so history survives server restarts
    persistSession(session);
    await sendMessage(waId, reply);
  } catch (err) {
    console.error('Meta LLM error:', err.message);
    return sendMessage(waId, friendlyLLMError(err));
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

  const hostUrl = (req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1'))
    ? `http://${req.get('host')}`
    : (process.env.PUBLIC_URL || `https://${req.get('host')}`);

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      const msgs = change.value?.messages;
      if (!msgs) continue;

      for (const msg of msgs) {
        const waId = msg.from;
        console.log(`\n📨 ${waId} [${msg.type}]`);

        try {
          if (msg.type === 'text') {
            await handleTextMessage(waId, msg.text?.body?.trim(), hostUrl);
          } else if (msg.type === 'document') {
            await handleFileMessage(waId, msg.document?.id, msg.document?.filename, hostUrl);
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
