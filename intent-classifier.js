// intent-classifier.js — Gemini-powered 5-intent JSON classifier for TELL OS
//
// Returns structured JSON with confidence score, signals, and conflict flag.
// The existing routePathway() still runs first as a safety/help pre-filter.
// This classifier runs only when a message needs genuine intent disambiguation.
//
// Intent labels:
//   EXCEL_UPLOAD   — spreadsheet file being sent or referenced
//   IMAGE_UPLOAD   — photo/image of physical records
//   DATA_INGESTION — text-based correction/update/add of stored data
//   DATA_ANALYTICS — question about business data
//   CLARIFICATION  — too ambiguous to route confidently

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { isDangerous, isSystemConfirmation } = require('./intent-router');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
// Use gemini-1.5-flash — reliable JSON mode support
const CLASSIFIER_MODEL = 'gemini-2.5-flash';

// ─── The classifier system prompt ─────────────────────────────────────────
// Kept verbatim to the spec. Template variables are replaced before the call.
const CLASSIFIER_PROMPT = `You are an intent classifier for TELL OS, a WhatsApp commerce assistant for Indian small business merchants.

Your only job is to classify the merchant's message into one intent label and report your confidence. You do not answer questions. You do not take actions. You only classify.
────────────────────────────────────────────────
INTENT LABELS — choose exactly one
────────────────────────────────────────────────
EXCEL_UPLOAD
The merchant is sending or referencing a spreadsheet file.
Signals: mentions of .xlsx, .xls, excel, sheet, file, spreadsheet, "sending file", "here is my data", "attached", media type is document, file attachment detected in message metadata

IMAGE_UPLOAD
The merchant has sent a photo or image of physical business records.
Signals: image/jpeg or image/png in message metadata, mentions of "photo", "picture", "notebook", "register", "handwritten", "account book", "stock book", "bill", "invoice photo", "receipt photo"
NOTE: An image of an Excel screenshot also routes here, not EXCEL_UPLOAD

DATA_INGESTION
The merchant wants to correct, update, replace, or add to existing stored data through text — no file involved.
Signals: wrong, incorrect, update, change, edit, fix, modify, re-enter, "price is wrong", "delete this product", "add new item manually"

DATA_ANALYTICS
The merchant wants to know something about their business data.
Signals: show, tell, how many, what is, which, who, revenue, orders, stock, products, customers, pending, top, best, total, count, "give me", "check my", question marks, possessives like "my orders"

CLARIFICATION
The message cannot be classified into any of the above with confidence above 0.65.
Use this when the message is a single word, greeting, confirmation word out of context, emoji only, or completely unrelated to business operations.

────────────────────────────────────────────────
CONFIDENCE SCORING — mandatory
────────────────────────────────────────────────

After classifying, score your confidence from 0.0 to 1.0.
High confidence (0.8 – 1.0): Multiple clear signals present.
  Example: "sending my products excel file" → EXCEL_UPLOAD, 0.95

Medium confidence (0.65 – 0.79): One clear signal or message is short but directional.
  Example: "here is the file" → EXCEL_UPLOAD, 0.70 (no explicit mention of excel)

Low confidence (below 0.65): Signals are ambiguous, conflicting, or absent.
  Example: "yes please" → CLARIFICATION, 0.40
  When confidence is below 0.65, always return CLARIFICATION regardless of which label seemed most likely. Never force a label on an unclear message.

────────────────────────────────────────────────
PRIORITY ORDER — when signals conflict
────────────────────────────────────────────────
If message metadata shows an attached file:
  → document/spreadsheet attachment = EXCEL_UPLOAD (override text analysis)
  → image attachment = IMAGE_UPLOAD (override text analysis)

If both image signals and analytics signals appear:
  → IMAGE_UPLOAD wins (the image must be processed before analytics is possible)

If both data entry and analytics signals appear:
  → Score both, return whichever scores higher
  → If gap is less than 0.15, return CLARIFICATION

────────────────────────────────────────────────
SESSION CONTEXT — use to improve accuracy
────────────────────────────────────────────────

Has uploaded data: {{UPLOAD_DONE}}
Current active flow: {{ACTIVE_FLOW}}
Last intent classified: {{LAST_INTENT}}
Pending confirmation: {{PENDING_CONFIRMATION}}

Rules:
- If PENDING_CONFIRMATION is true AND message is bare yes/no/ok/sure/cancel → classify as {{ACTIVE_FLOW}}, confidence 0.95. Do not override with other signals.
- If ACTIVE_FLOW is EXCEL_UPLOAD and merchant says "wait" or "hold on" → CLARIFICATION, not DATA_INGESTION
- If UPLOAD_DONE is false and message looks like DATA_ANALYTICS → still return DATA_ANALYTICS but set confidence to 0.55 maximum (system will handle the "no data yet" response — your job is only to classify)

────────────────────────────────────────────────
OUTPUT FORMAT — strictly enforced
────────────────────────────────────────────────

Return only valid JSON. No explanation. No text outside the JSON.

{
  "intent": "INTENT_LABEL",
  "confidence": 0.00,
  "signals_detected": ["signal1", "signal2"],
  "conflict": false,
  "conflict_note": ""
}

conflict is true only when two intents scored within 0.15 of each other.
conflict_note describes which two intents conflicted and why, in one sentence.
signals_detected: list maximum 3 signals, use short labels only (2-4 words each).
Do not write full sentences in signals_detected.

────────────────────────────────────────────────
MERCHANT MESSAGE
────────────────────────────────────────────────

Message text: {{MESSAGE}}
Message metadata: {{MESSAGE_METADATA}}`;

// ─── Build the injected prompt ─────────────────────────────────────────────
function buildPrompt(message, messageMetadata, sessionContext) {
  const {
    uploadDone        = false,
    activeFlow        = 'none',
    lastIntent        = 'none',
    pendingConfirmation = false,
  } = sessionContext;

  return CLASSIFIER_PROMPT
    .replace('{{UPLOAD_DONE}}',          String(uploadDone))
    .replace('{{ACTIVE_FLOW}}',          activeFlow || 'none')
    .replace('{{LAST_INTENT}}',          lastIntent || 'none')
    .replace(/\{\{ACTIVE_FLOW\}\}/g,     activeFlow || 'none')   // appears twice
    .replace('{{PENDING_CONFIRMATION}}', String(pendingConfirmation))
    .replace('{{MESSAGE}}',              message)
    .replace('{{MESSAGE_METADATA}}',     typeof messageMetadata === 'string'
      ? messageMetadata
      : JSON.stringify(messageMetadata || {}));
}

// ─── Validate the parsed JSON result ──────────────────────────────────────
const VALID_INTENTS = new Set([
  'EXCEL_UPLOAD', 'IMAGE_UPLOAD', 'DATA_INGESTION', 'DATA_ANALYTICS', 'CLARIFICATION',
]);

function validateResult(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
  if (!VALID_INTENTS.has(parsed.intent))    throw new Error(`Invalid intent: ${parsed.intent}`);
  if (typeof parsed.confidence !== 'number') throw new Error('confidence must be number');
  if (!Array.isArray(parsed.signals_detected)) parsed.signals_detected = [];
  if (typeof parsed.conflict !== 'boolean')    parsed.conflict = false;
  if (typeof parsed.conflict_note !== 'string') parsed.conflict_note = '';

  // Clamp confidence to [0, 1]
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));

  // Enforce: confidence < 0.65 → must be CLARIFICATION
  if (parsed.confidence < 0.65 && parsed.intent !== 'CLARIFICATION') {
    parsed.intent           = 'CLARIFICATION';
    parsed.conflict         = false;
    parsed.conflict_note    = '';
  }

  return parsed;
}

// ─── Map 5-intent label → server route ────────────────────────────────────
function intentToRoute(intent) {
  switch (intent) {
    case 'EXCEL_UPLOAD':    return 'data_entry';
    case 'IMAGE_UPLOAD':    return 'data_entry';
    case 'DATA_INGESTION':  return 'data_entry';
    case 'DATA_ANALYTICS':  return 'data_analytics';
    case 'CLARIFICATION':   return 'clarification';
    default:                return 'clarification';
  }
}

// ─── Main classifier ───────────────────────────────────────────────────────
/**
 * Classify a merchant message using Gemini JSON mode.
 *
 * @param {string}  message          - Raw message text
 * @param {object}  messageMetadata  - Attachment info, e.g. { attachment_type: 'image/jpeg' }
 * @param {object}  session          - Session object (uploadDone, activeFlow, etc.)
 * @returns {Promise<ClassificationResult>}
 *
 * ClassificationResult shape:
 * {
 *   intent:           'EXCEL_UPLOAD' | 'IMAGE_UPLOAD' | 'DATA_INGESTION' | 'DATA_ANALYTICS' | 'CLARIFICATION'
 *   confidence:       number (0–1)
 *   signals_detected: string[]
 *   conflict:         boolean
 *   conflict_note:    string
 *   route:            'data_entry' | 'data_analytics' | 'clarification'
 *   fallback_used:    boolean  (true if Gemini failed and we used regex router)
 *   raw_response:     string   (unparsed Gemini output, for logging)
 * }
 */
const trace = require('./trace');

async function classifyIntent(message, messageMetadata = {}, session = {}) {
  const tStart = Date.now();
  trace.logFunctionEntered('intent-classifier.js', 'classifyIntent', { message, messageMetadata, sessionKeys: Object.keys(session) }, 'server.js');

  // ── Short-circuit 1: dangerous commands ──────────────────────────────────
  if (isDangerous(message)) {
    const res = {
      intent:           'CLARIFICATION',
      confidence:       1.0,
      signals_detected: ['dangerous_command_detected'],
      conflict:         false,
      conflict_note:    '',
      route:            'safety_block',   // special: bypasses threshold gate
      fallback_used:    false,
      raw_response:     '',
    };
    trace.logFunctionResult('intent-classifier.js', 'classifyIntent', res, Date.now() - tStart);
    return res;
  }

  // ── Short-circuit 2: pending confirmation (bare yes/no in active flow) ───
  if (session.pendingConfirmation && isSystemConfirmation(message, session)) {
    const activeFlow  = session.activeFlow || 'data_entry';
    const mappedRoute = activeFlow === 'data_analytics' ? 'data_analytics' : 'data_entry';
    const res = {
      intent:           activeFlow === 'data_analytics' ? 'DATA_ANALYTICS' : 'EXCEL_UPLOAD',
      confidence:       0.95,
      signals_detected: ['pending_confirmation_true', 'bare_confirmation_word'],
      conflict:         false,
      conflict_note:    '',
      route:            mappedRoute,
      fallback_used:    false,
      raw_response:     '',
    };
    trace.logFunctionResult('intent-classifier.js', 'classifyIntent', res, Date.now() - tStart);
    return res;
  }

  // ── Skip classifier when not configured ─────────────────────────────────
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    const res = await _fallbackClassification(message, session, 'no_api_key');
    trace.logFunctionResult('intent-classifier.js', 'classifyIntent', res, Date.now() - tStart);
    return res;
  }

  // ── Gemini JSON classification ───────────────────────────────────────────
  let rawResponse = '';
  try {
    const model = genAI.getGenerativeModel({
      model: CLASSIFIER_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature:      0.0,    // fully deterministic
        maxOutputTokens:  1024,    // JSON response needs headroom for signals array
      },
    });

    const sessionContext = {
      uploadDone:          !!session.uploadDone,
      activeFlow:          session.activeFlow        || session.lastRoute || 'none',
      lastIntent:          session.lastClassifiedIntent || 'none',
      pendingConfirmation: !!session.pendingConfirmation,
    };

    const prompt = buildPrompt(message, messageMetadata, sessionContext);
    trace.logGeminiRequest(CLASSIFIER_MODEL, prompt, message, JSON.stringify(sessionContext));
    trace.logDataTransfer('classifyIntent', 'model.generateContent', { promptLength: prompt.length });
    
    const result = await model.generateContent(prompt);
    rawResponse  = result.response.text().trim();
    
    const latency = Date.now() - tStart;
    trace.logGeminiResponse(CLASSIFIER_MODEL, rawResponse, latency, prompt, message, JSON.stringify(sessionContext));

    // Strip markdown code fences (```json ... ```) if present
    let cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    // If Gemini prefixed with text like "Here is the JSON:", extract the JSON object
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd   = cleaned.lastIndexOf('}');
    if (jsonStart > 0 && jsonEnd > jsonStart) {
      cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }

    const parsed    = JSON.parse(cleaned);
    const validated = validateResult(parsed);

    // Attach route and meta
    validated.route        = intentToRoute(validated.intent);
    validated.fallback_used = false;
    validated.raw_response  = rawResponse;

    console.log(`🎯 Intent: ${validated.intent} (${validated.confidence.toFixed(2)}) conflict=${validated.conflict} | signals: [${validated.signals_detected.join(', ')}]`);
    trace.logFunctionResult('intent-classifier.js', 'classifyIntent', validated, latency);
    return validated;

  } catch (err) {
    trace.logError('classifyIntent', { message, messageMetadata }, err, 'Gemini classification flow');
    console.error('⚠️  Intent classifier error:', err.message, '| raw:', rawResponse?.slice(0, 120));
    // Graceful fallback — never block the user
    const res = await _fallbackClassification(message, session, err.message);
    trace.logFunctionResult('intent-classifier.js', 'classifyIntent', res, Date.now() - tStart);
    return res;
  }
}

// ─── Fallback: map routePathway() result to ClassificationResult ──────────
async function _fallbackClassification(message, session, reason) {
  const { routePathway, resolveAnalyticsIntent } = require('./intent-router');
  let fallbackRoute = 'clarification';
  try {
    const pathway = await routePathway(message, session);
    fallbackRoute = pathway.route;
  } catch (_) {}

  // If the pathway returned pass_to_classifier, resolve locally using the keyword scanner
  if (fallbackRoute === 'pass_to_classifier') {
    if (session.uploadDone) {
      const resolvedAnalytics = resolveAnalyticsIntent(message);
      fallbackRoute = resolvedAnalytics ? 'data_analytics' : 'data_entry';
    } else {
      fallbackRoute = 'data_entry';
    }
  }

  // Map old route → 5-intent label
  const intentMap = {
    data_analytics: 'DATA_ANALYTICS',
    data_entry:     'DATA_INGESTION',
    safety_block:   'CLARIFICATION',
    onboarding:     'CLARIFICATION',
    clarification:  'CLARIFICATION',
  };

  return {
    intent:           intentMap[fallbackRoute] || 'CLARIFICATION',
    confidence:       0.85,   // Treat fallback route as high confidence to bypass clarification block
    signals_detected: [`fallback:${reason?.slice(0, 40)}`],
    conflict:         false,
    conflict_note:    '',
    route:            fallbackRoute,
    fallback_used:    true,
    raw_response:     '',
  };
}

module.exports = { classifyIntent, intentToRoute, VALID_INTENTS };
