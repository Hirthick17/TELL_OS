// sessions.js — MongoDB-backed session store
// Hybrid: in-memory Map (fast) + MongoDB (survives restarts)
// Phase 2 fix: Map alone is lost on Railway restart — this persists state.

const { randomUUID } = require('crypto');   // built-in Node.js, no package needed
const { connect }    = require('./db');

// In-memory cache — fast reads, backed by MongoDB writes
const cache = new Map();

// ─── Default session shape ────────────────────────────────────────────────
function defaultSession(sessionId, phoneNumber = null, channel = 'web') {
  return {
    sessionId,                  // UUID — also the dashboardId
    phoneNumber,                // null for web UI, phone number for WhatsApp
    channel,                    // 'web' | 'whatsapp'
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

// ─── Get or create session by phone number (WhatsApp) ────────────────────
// Ensures one persistent session per phone number across restarts
async function getSessionByPhone(phoneNumber) {
  // Check in-memory cache first
  for (const s of cache.values()) {
    if (s.phoneNumber === phoneNumber) return s;
  }

  // Check MongoDB
  try {
    const db  = await connect();
    const doc = await db.collection('conversations').findOne({ phoneNumber });
    if (doc) {
      cache.set(doc.sessionId, doc);
      return doc;
    }
  } catch {}

  // New WhatsApp session — UUID becomes their dashboard ID
  const sessionId = randomUUID();
  const session   = defaultSession(sessionId, phoneNumber, 'whatsapp');
  cache.set(sessionId, session);
  saveToDB(session);
  return session;
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

module.exports = { getSession, getSessionByPhone, persistSession, newSessionId, cache };
