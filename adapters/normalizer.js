// adapters/normalizer.js
// Platform-neutral translation layer for incoming messages.
// Converts raw Meta platform payloads into a clean, platform-agnostic shape
// that downstream layers can consume without knowing the wire format.
//
// Exports:
//   normalizeWhatsAppMessage(waId, msg, hostUrl)   — WhatsApp Cloud API
//   normalizeInstagramMessage(senderId, event)     — Instagram Messenger Platform

'use strict';

/**
 * Normalizes a single raw WhatsApp Cloud API message object into a
 * platform-neutral representation.
 *
 * @param {string} waId    - The sender's WhatsApp ID (msg.from).
 * @param {object} msg     - A single message object from change.value.messages[].
 * @param {string} hostUrl - The resolved public host URL of this server instance.
 * @returns {{
 *   platform:   string,
 *   senderId:   string,
 *   sessionKey: string,
 *   type:       'text' | 'image' | 'document' | 'unsupported',
 *   text:       string | null,
 *   mediaId:    string | null,
 *   fileName:   string | null,
 *   timestamp:  number,
 *   raw:        object
 * }}
 */
function normalizeWhatsAppMessage(waId, msg, hostUrl) {
  // -- Type resolution -------------------------------------------------------
  const SUPPORTED_TYPES = new Set(['text', 'image', 'document']);
  const rawType = msg && msg.type;
  const type = SUPPORTED_TYPES.has(rawType) ? rawType : 'unsupported';

  // -- Text body -------------------------------------------------------------
  // Only populated for text messages; null for all other types.
  const text = type === 'text'
    ? (msg.text?.body?.trim() ?? null)
    : null;

  // -- Media identifiers -----------------------------------------------------
  // mediaId is the opaque Meta media ID used to download the file.
  const mediaId = type === 'image'
    ? (msg.image?.id ?? null)
    : type === 'document'
      ? (msg.document?.id ?? null)
      : null;

  // fileName is only meaningful for documents; images have no filename.
  const fileName = type === 'document'
    ? (msg.document?.filename ?? null)
    : null;

  // -- Timestamp -------------------------------------------------------------
  // The WhatsApp webhook provides msg.timestamp as a Unix seconds string.
  // If it is absent or unparseable, fall back to Date.now() (milliseconds).
  let timestamp;
  if (msg && msg.timestamp !== undefined && msg.timestamp !== null) {
    const parsed = Number(msg.timestamp) * 1000; // convert seconds -> ms
    timestamp = Number.isFinite(parsed) ? parsed : Date.now();
  } else {
    timestamp = Date.now();
  }

  // -- Assemble normalized object --------------------------------------------
  return {
    platform:   'whatsapp',
    senderId:   waId,
    sessionKey: `whatsapp:${waId}`,
    type,
    text,
    mediaId,
    fileName,
    timestamp,
    raw:        msg,  // original msg object, unmodified, for debugging
  };
}

/**
 * Normalizes a single Instagram Messenger Platform messaging event into the
 * same platform-neutral shape as normalizeWhatsAppMessage().
 *
 * Payload path (from req.body):
 *   entry[].messaging[].sender.id            → senderId
 *   entry[].messaging[].message.text         → text
 *   entry[].messaging[].message.attachments  → type / mediaId
 *   entry[].messaging[].timestamp            → timestamp (Unix ms, not seconds)
 *
 * Key differences from WhatsApp:
 *   - mediaId is the CDN URL directly (no separate resolve step needed).
 *   - Instagram never provides a fileName for attachments.
 *   - timestamp is already in milliseconds (not seconds).
 *   - Attachment types are 'image', 'video', 'audio', 'file' — we map
 *     'file' → 'document', 'video'/'audio' → 'unsupported' for now.
 *
 * @param {string} senderId     - Instagram-scoped user ID (event.sender.id).
 * @param {object} event        - A single messaging event object from
 *                                entry[].messaging[].
 * @returns {{
 *   platform:   string,
 *   senderId:   string,
 *   sessionKey: string,
 *   type:       'text' | 'image' | 'document' | 'unsupported',
 *   text:       string | null,
 *   mediaId:    string | null,
 *   fileName:   string | null,
 *   timestamp:  number,
 *   raw:        object
 * }}
 */
function normalizeInstagramMessage(senderId, event) {
  const message = event && event.message;

  // -- Type resolution -------------------------------------------------------
  // Prefer attachments over text (an event can have both if the user sends a
  // caption with an image, though Instagram usually separates them).
  let type     = 'unsupported';
  let text     = null;
  let mediaId  = null;
  const fileName = null; // Instagram Messenger never exposes a filename

  if (message) {
    const attachments = message.attachments;

    if (attachments && attachments.length > 0) {
      // Use the first attachment only; multi-attachment events are rare in DMs.
      const att = attachments[0];
      const attType = att.type; // 'image' | 'video' | 'audio' | 'file' | 'fallback'

      if (attType === 'image') {
        type    = 'image';
        // CDN URL — see ⚠️ auth note below
        mediaId = att.payload?.url ?? null;
      } else if (attType === 'file') {
        type    = 'document';
        mediaId = att.payload?.url ?? null;
      } else {
        // 'video', 'audio', 'fallback', 'template', etc. — unsupported for now
        type    = 'unsupported';
        mediaId = att.payload?.url ?? null; // preserve URL for debugging via raw
      }
    } else if (typeof message.text === 'string') {
      type = 'text';
      text = message.text.trim() || null;
    }
    // If message.text exists alongside attachments, it is intentionally ignored
    // here — the attachment branch takes precedence (caption scenario).
  }

  // -- Timestamp -------------------------------------------------------------
  // Instagram Messenger webhooks provide event.timestamp in Unix MILLISECONDS
  // (unlike WhatsApp which uses Unix seconds). Fall back to Date.now() if absent.
  let timestamp;
  if (event && event.timestamp !== undefined && event.timestamp !== null) {
    const parsed = Number(event.timestamp);
    timestamp = Number.isFinite(parsed) ? parsed : Date.now();
  } else {
    timestamp = Date.now();
  }

  // -- Assemble normalized object --------------------------------------------
  return {
    platform:   'instagram',
    senderId,
    sessionKey: `instagram:${senderId}`,
    type,
    text,
    mediaId,   // ⚠️ See auth note in adapters/instagram.js — this is a CDN URL
    fileName,  // Always null for Instagram (platform does not expose filenames)
    timestamp,
    raw:        event, // original messaging event, unmodified, for debugging
  };
}

module.exports = { normalizeWhatsAppMessage, normalizeInstagramMessage };
