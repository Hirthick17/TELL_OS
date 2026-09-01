// sessions.js — MongoDB-backed session store
// Hybrid: in-memory Map (fast) + MongoDB (survives restarts)
// Phase 2 fix: Map alone is lost on Railway restart — this persists state.

const { randomUUID } = require('crypto');   // built-in Node.js, no package needed
const { connect }    = require('./db');

// In-memory cache — fast reads, backed by MongoDB writes
const cache = new Map();

// ─── Default session shape ────────────────────────────────────────────────
function defaultSession(sessionId, phoneNumber = null, channel = 'web', sessionKey = null) {
  return {
    sessionId,                  // UUID — also the dashboardId
    phoneNumber,                // null for web UI, phone number for WhatsApp
    channel,                    // 'web' | 'whatsapp'
    sessionKey,                 // Generic lookup key: `${channel}:${rawId}`, e.g. 'whatsapp:919999'
    history:        [],         // Gemini chat history (capped at 20 turns)
    messages:       [],         // Full message log for web UI
    awaitingUpload: false,
    uploadDone:     false,
    confirmed:      false,
    pendingPreview: null,       // Parsed Excel data awaiting confirmation
    createdAt:      new Date(),
    updatedAt:      new Date(),
    // ── Intent router state ──────────────────────────────────────────────
    recentRoutes:        [],    // Last 5 routes (for Layer 3 context bias)
    lastRoute:           null,  // Most recent route taken
    activeFlow:          null,  // Current active flow: 'data_entry' | 'data_analytics'
    pendingConfirmation: false, // true when awaiting a bare yes/no (Layer 1 gate)
  };
}

// ─── Load session from MongoDB (on cache miss) ────────────────────────────
async function loadFromDB(sessionId) {
  try {
    const db   = await connect();
    const doc  = await db.collection('conversations').findOne({ sessionId });
    return doc || null;
  } catch { return null; }
}

// ─── Persist session to MongoDB (async, non-blocking) ────────────────────
async function saveToDB(session) {
  try {
    const db = await connect();
    await db.collection('conversations').updateOne(
      { sessionId: session.sessionId },
      { $set: { ...session, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('Session save error:', err.message);
  }
}

// ─── Get or create session by sessionId ──────────────────────────────────
async function getSession(sessionId) {
  if (cache.has(sessionId)) return cache.get(sessionId);

  // Try loading from MongoDB (handles server restarts)
  const existing = await loadFromDB(sessionId);
  if (existing) {
    cache.set(sessionId, existing);
    return existing;
  }

  // Brand new session
  const session = defaultSession(sessionId);
  cache.set(sessionId, session);
  saveToDB(session);   // async — don't await
  return session;
}

// ─── Get or create session by generic platform key ───────────────────────
// Primary lookup path. sessionKey format: `${channel}:${rawId}`
// e.g. 'whatsapp:919999999999', 'telegram:user123'
//
// channel  — platform identifier string ('whatsapp', 'telegram', etc.)
// rawId    — the platform-native sender ID (phone number, user ID, etc.)
//            stored in `phoneNumber` for backward compat with WhatsApp callers
async function getSessionByKey(sessionKey, channel, rawId) {
  // 1. In-memory cache check
  for (const s of cache.values()) {
    if (s.sessionKey === sessionKey) return s;
  }

  // 2. MongoDB lookup by sessionKey index
  try {
    const db  = await connect();
    const doc = await db.collection('conversations').findOne({ sessionKey });
    if (doc) {
      cache.set(doc.sessionId, doc);
      return doc;
    }
  } catch {}

  // 3. New session — UUID becomes the dashboard ID
  const sessionId = randomUUID();
  // phoneNumber carries rawId so all existing WhatsApp reply paths keep working
  const session   = defaultSession(sessionId, rawId, channel, sessionKey);
  cache.set(sessionId, session);
  saveToDB(session);
  return session;
}

// ─── Get or create session by phone number (WhatsApp) ────────────────────
// Retained for full backward compatibility — all existing callers continue
// to work without modification. Internally delegates to getSessionByKey.
async function getSessionByPhone(phoneNumber) {
  return getSessionByKey(`whatsapp:${phoneNumber}`, 'whatsapp', phoneNumber);
}

// ─── Persist session state changes ───────────────────────────────────────
// Call after mutating session fields (awaitingUpload, uploadDone, etc.)
function persistSession(session) {
  // Keep history capped at 20 turns to prevent MongoDB doc bloat
  if (session.history.length > 40) {
    session.history = session.history.slice(-40);
  }
  // Keep messages capped at 100 for UI restore
  if (session.messages.length > 100) {
    session.messages = session.messages.slice(-100);
  }
  saveToDB(session);  // async
}

// ─── Generate new UUID-based session ID ──────────────────────────────────
function newSessionId() {
  return randomUUID();
}

module.exports = { getSession, getSessionByPhone, getSessionByKey, persistSession, newSessionId, cache };
