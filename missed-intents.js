// missed-intents.js — MongoDB layer for the self-improving missed intent queue
//
// Every low-confidence or conflicted classification is stored here.
// When the merchant next sends a HIGH-confidence message, the previous document
// gets backfilled with the correct intent — automatic active learning.
//
// Collection: missed_intents
// Index:      { sessionId: 1, resolved: 1, created_at: -1 }

const { connect } = require('./db');

const COLLECTION = 'missed_intents';

// ─── Store a missed intent document ───────────────────────────────────────
/**
 * Called when confidence < 0.80 OR conflict: true.
 *
 * @param {object} data
 * @param {string} data.message_text
 * @param {object} data.message_metadata       - attachment type, timestamp
 * @param {string} data.returned_intent        - what the classifier returned
 * @param {number} data.confidence
 * @param {string[]} data.signals_detected
 * @param {boolean} data.conflict
 * @param {string} data.conflict_note
 * @param {object} data.session_snapshot       - { upload_done, active_flow, last_intent, merchant_id }
 * @param {string} [data.reason]               - 'low_confidence' | 'conflict' | 'fallback'
 * @returns {Promise<string>} - inserted document _id as string
 */
async function storeMissedIntent(data) {
  try {
    const db = await connect();
    const doc = {
      message_text:      data.message_text      || '',
      message_metadata:  data.message_metadata  || {},
      returned_intent:   data.returned_intent   || 'CLARIFICATION',
      confidence:        typeof data.confidence === 'number' ? data.confidence : 0,
      signals_detected:  Array.isArray(data.signals_detected) ? data.signals_detected : [],
      conflict:          !!data.conflict,
      conflict_note:     data.conflict_note      || '',
      session_snapshot:  data.session_snapshot  || {},
      merchant_response: null,     // filled by next message from this session
      correct_intent:    null,     // filled by backfill or manual review
      reason:            data.reason || 'low_confidence',
      resolved:          false,
      created_at:        new Date(),
    };
    const result = await db.collection(COLLECTION).insertOne(doc);
    console.log(`📋 Missed intent stored: ${doc.returned_intent} (${doc.confidence.toFixed(2)}) | session ${doc.session_snapshot?.merchant_id?.slice(0, 8)}`);
    return result.insertedId.toString();
  } catch (err) {
    console.error('⚠️  storeMissedIntent failed (non-blocking):', err.message);
    return null;
  }
}

// ─── Backfill: fill in the previous unresolved doc ────────────────────────
/**
 * Called when the NEXT message from the same session classifies at >= 0.80.
 * Fills in:
 *   - merchant_response: the new high-confidence message text
 *   - correct_intent:    the new high-confidence intent
 *
 * Only backfills the single most recent unresolved document for this session.
 *
 * @param {string} sessionId
 * @param {string} correctIntent  - the high-confidence intent that followed
 * @param {string} merchantResponse - the new message text that triggered it
 */
async function backfillCorrectIntent(sessionId, correctIntent, merchantResponse) {
  try {
    const db = await connect();
    const result = await db.collection(COLLECTION).updateOne(
      {
        'session_snapshot.merchant_id': sessionId,
        correct_intent: null,
        resolved:       false,
      },
      {
        $set: {
          correct_intent:    correctIntent,
          merchant_response: merchantResponse,
          backfilled_at:     new Date(),
        },
      },
      { sort: { created_at: -1 } }   // most recent unresolved first
    );
    if (result.modifiedCount > 0) {
      console.log(`✅ Backfilled correct_intent=${correctIntent} for session ${sessionId.slice(0, 8)}`);
    }
  } catch (err) {
    console.error('⚠️  backfillCorrectIntent failed (non-blocking):', err.message);
  }
}

// ─── Admin: query missed intents ──────────────────────────────────────────
/**
 * Returns missed intent documents for admin review.
 *
 * @param {object} filters
 * @param {boolean} [filters.resolved]      - filter by resolved flag
 * @param {string}  [filters.sessionId]     - filter by session
 * @param {string}  [filters.intent]        - filter by returned_intent
 * @param {number}  [filters.limit=50]
 * @param {number}  [filters.skip=0]
 * @returns {Promise<object[]>}
 */
async function getMissedIntents({ resolved, sessionId, intent, limit = 50, skip = 0 } = {}) {
  const db    = await connect();
  const query = {};

  if (typeof resolved === 'boolean')  query.resolved       = resolved;
  if (sessionId)                      query['session_snapshot.merchant_id'] = sessionId;
  if (intent)                         query.returned_intent = intent;

  return db.collection(COLLECTION)
    .find(query, { projection: { _id: 1, message_text: 1, returned_intent: 1, confidence: 1,
      signals_detected: 1, conflict: 1, conflict_note: 1, correct_intent: 1,
      merchant_response: 1, reason: 1, resolved: 1, created_at: 1,
      'session_snapshot.merchant_id': 1, 'session_snapshot.upload_done': 1 } })
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(Math.min(limit, 200))
    .toArray();
}

// ─── Admin: manually resolve a missed intent doc ──────────────────────────
/**
 * @param {string} id          - document _id as string
 * @param {string} correctIntent - manually determined correct intent
 * @returns {Promise<boolean>}
 */
async function resolveMissedIntent(id, correctIntent) {
  try {
    const { ObjectId } = require('mongodb');
    const db     = await connect();
    const result = await db.collection(COLLECTION).updateOne(
      { _id: new ObjectId(id) },
      { $set: {
          resolved:       true,
          correct_intent: correctIntent || null,
          resolved_at:    new Date(),
        },
      }
    );
    return result.modifiedCount > 0;
  } catch (err) {
    console.error('⚠️  resolveMissedIntent failed:', err.message);
    return false;
  }
}

// ─── Stats: quick summary for admin dashboard ─────────────────────────────
/**
 * Returns counts by intent and resolution status.
 */
async function getMissedIntentStats() {
  try {
    const db = await connect();
    const [total, unresolved, byIntent] = await Promise.all([
      db.collection(COLLECTION).countDocuments({}),
      db.collection(COLLECTION).countDocuments({ resolved: false }),
      db.collection(COLLECTION).aggregate([
        { $group: { _id: '$returned_intent', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
    ]);
    return { total, unresolved, byIntent };
  } catch (_) {
    return { total: 0, unresolved: 0, byIntent: [] };
  }
}

module.exports = {
  storeMissedIntent,
  backfillCorrectIntent,
  getMissedIntents,
  resolveMissedIntent,
  getMissedIntentStats,
};
