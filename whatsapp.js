const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode            = require('qrcode-terminal');
const path              = require('path');
const fs                = require('fs');
const { detectSheetsAndColumns, streamSheet, extractSamples, buildSheetMetadata, parseExcel } = require('./parser');
const db                = require('./db');
const { chat, friendlyLLMError } = require('./llm');       // ← shared Gemini logic
const { getSession }    = require('./sessions');  // ← shared session store
const intelligence      = require('./intelligence');
const { routePathway }  = require('./intent-router');
const { classifyIntent } = require('./intent-classifier');
const { storeMissedIntent, backfillCorrectIntent } = require('./missed-intents');

const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ─── Handle incoming text message ──────────────────────────────────────────
async function handleTextMessage(client, msg, session, phoneNumber) {
  const text = msg.body.trim();
  const waId = phoneNumber;

  // Sync derived flags so Layer 1 gates work correctly
  session.pendingConfirmation = !!session.pendingPreview;
  if (session.pendingPreview || session.awaitingUpload) session.activeFlow = 'data_entry';

  // ── STEP 1: Hard safety + onboarding gates (fast, no LLM) ────────────
  const pathway = await routePathway(text, session);
  console.log(`🧭 [WA-Client] Route: ${pathway.route} (confident=${pathway.confident}) | ${waId}`);

  // ── SAFETY BLOCK ─────────────────────────────────────────
  if (pathway.route === 'safety_block') {
    return client.sendMessage(waId, `⚠️ That action isn't available through chat. Please contact support if you need to reset your data.`);
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
      db.confirmSession(session.sessionId).catch(() => {});
      return client.sendMessage(waId, reply);
    } catch (err) {
      return client.sendMessage(waId, friendlyLLMError(err));
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
    console.log(`🎯 [WA-Client] Classified: ${classification.intent} (${classification.confidence.toFixed(2)}) fallback=${classification.fallback_used} | ${waId}`);
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
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp-web' },
      returned_intent:  intent,
      confidence,
      signals_detected: classification.signals_detected,
      conflict:         true,
      conflict_note:    classification.conflict_note,
      session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: session.sessionId },
      reason:           'conflict',
    }).catch(() => {});
    return client.sendMessage(waId, clarifyReply);
  }

  // Low confidence → clarification + log
  if (confidence < THRESHOLD_LOG && !skipClassifier) {
    const clarifyReply = `I didn't quite catch that. Did you want to:\n\n*1.* 📊 Check your analytics — orders, stock, revenue\n*2.* 📂 Upload or update your data\n*3.* ❓ Something else\n\nJust reply with a number or rephrase your question!`;
    session.history.push({ role: 'user',  parts: [{ text }] });
    session.history.push({ role: 'model', parts: [{ text: clarifyReply }] });
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp-web' },
      returned_intent:  intent,
      confidence,
      signals_detected: classification.signals_detected,
      conflict:         false,
      conflict_note:    '',
      session_snapshot: { upload_done: !!session.uploadDone, active_flow: session.activeFlow, last_intent: session.lastClassifiedIntent, merchant_id: session.sessionId },
      reason:           'low_confidence',
    }).catch(() => {});
    return client.sendMessage(waId, clarifyReply);
  }

  // Medium confidence (0.65–0.79) → route but log for review
  if (confidence < THRESHOLD_ROUTE && !skipClassifier) {
    storeMissedIntent({
      message_text:     text,
      message_metadata: { source: 'whatsapp-web' },
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
    return client.sendMessage(waId, clarifyReply);
  }

  if (effectiveRoute === 'data_analytics') {
    // Flexible analytics pathway - with Query Planner execution
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
          console.warn('[WA-Client] Intelligence query execution failed:', planErr.message);
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
      console.log(`📊 [WA-Client] Flexible Analytics: ${waId}`);
      return client.sendMessage(waId, reply);
    } catch (err) {
      return client.sendMessage(waId, friendlyLLMError(err));
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
    return client.sendMessage(waId, reply);
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

      const currentHostUrl = p.hostUrl || PUBLIC_URL;
      const dashboardUrl = `${currentHostUrl}/dashboard/${session.sessionId}`;
      const reply = `🎉 Done! ${insertedTotal} rows saved across ${metaSheets.length} sheet(s).\n\n📊 Your live dashboard:\n${dashboardUrl}`;
      
      session.history.push({ role: 'model', parts: [{ text: reply }] });
      return client.sendMessage(waId, reply);

    } catch (err) {
      console.error('WhatsApp save error:', err.message);
      return client.sendMessage(waId, `❌ Could not save data: ${err.message}`);
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
    contextNote = `[Context: Data already stored. Dashboard: ${PUBLIC_URL}/dashboard/${session.sessionId}. Do NOT ask them to upload again.]`;
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

    await client.sendMessage(waId, reply);
  } catch (err) {
    console.error('Meta LLM error:', err.message);
    return client.sendMessage(waId, friendlyLLMError(err));
  }
}

// ─── Handle Excel file attachment ──────────────────────────────────────────
async function handleFileMessage(client, msg, session) {
  const waId = msg.from;
  try {
    await client.sendMessage(waId, '📥 Got your file! Scanning it...');

    const media = await msg.downloadMedia();
    if (!media) {
      await client.sendMessage(waId, '❌ Could not download the file. Please try again.');
      return;
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(media.data, 'base64');
    const filename = msg._data?.filename || 'uploaded.xlsx';
    const ext = path.extname(filename).toLowerCase();

    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
      await client.sendMessage(waId, `❌ Please send an Excel file (.xlsx or .csv), not a ${ext} file.`);
      return;
    }

    const plan = detectSheetsAndColumns(buffer);
    const knownSheets = plan.sheets;

    if (knownSheets.length === 0) {
      const reply = `❌ Couldn't read data from this file.\n\nMake sure columns have labels like:\n• Product Name, Price, SKU\n• Order ID, Customer Name, Amount\n• Stock, Reorder Level\n• Payment ID, Payment Method\n\nTry again with the correct format.`;
      await client.sendMessage(waId, reply);
      return;
    }

    // Build summary lines
    const typeCounts = {};
    for (const s of knownSheets) {
      typeCounts[s.type] = (typeCounts[s.type] || 0) + s.rowCount;
    }
    const EMOJI = { products: '📦', orders: '🛒', inventory: '🏪', payments: '💳' };
    const lines = Object.entries(typeCounts).map(([t, c]) => `${EMOJI[t] || '📄'} *${c} ${t.charAt(0).toUpperCase()+t.slice(1)}* detected`);

    // Store in pending (don't save to DB yet)
    session.pendingPreview = {
      sheetSummary: plan.sheets,
      fileName: filename,
      fileBuffer: media.data, // save base64
      hostUrl: PUBLIC_URL,
    };
    session.awaitingUpload = false;

    const sheetInfo = knownSheets.map(s => {
      const lowConf = Object.entries(s.confidences || {}).filter(([, v]) => v < 0.9).map(([k]) => k);
      const flagNote = lowConf.length > 0 ? ` ⚠️ (low confidence: ${lowConf.join(', ')})` : '';
      return `  • ${s.sheetName} → ${s.type} (${s.rowCount} rows, cols: ${s.headers.slice(0,3).join(', ')}...)${flagNote}`;
    }).join('\n');

    const unmatchedBySheet = knownSheets
      .filter(s => s.unmatchedHeaders && s.unmatchedHeaders.length > 0)
      .map(s => `  • ${s.sheetName}: ${s.unmatchedHeaders.join(', ')}`)
      .join('\n');

    let reply = `✅ Scanned *${filename}*\n\n` +
      `Here's what I found:\n${lines.join('\n')}\n\n` +
      `📋 Sheets:\n${sheetInfo}`;

    if (unmatchedBySheet) {
      reply += `\n\n⚠️ Some columns couldn't be auto-identified:\n${unmatchedBySheet}\n` +
        `These will be stored with their original names.`;
    }

    reply += `\n\n💾 *Should I store this data in your account?*\nReply *Yes* to save or *No* to cancel.`;

    session.history.push({ role: 'user', parts: [{ text: `[Sent Excel file: ${filename}]` }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    await client.sendMessage(waId, reply);

  } catch (err) {
    console.error('WA file error:', err.message);
    await client.sendMessage(waId, `❌ Error processing file: ${err.message}`);
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
