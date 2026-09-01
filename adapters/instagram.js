// adapters/instagram.js — Meta Instagram Messenger Platform webhook adapter
// Mirrors the structure of meta-whatsapp.js but handles Instagram DM payloads.
// Docs: https://developers.facebook.com/docs/messenger-platform/instagram
//
// ⚠️  IMPORTANT — MEDIA DOWNLOAD AUTH NOTE:
// Instagram Messenger Platform attachment payload.url values are PRE-SIGNED
// CDN URLs. They do NOT require an Authorization header to download, BUT they
// expire (typically within a few minutes after the webhook is delivered).
// Download them promptly — do NOT store the URL and fetch later.
//
// This is DIFFERENT from the WhatsApp Cloud API, where media IDs must first
// be exchanged for a URL via a separate authenticated Graph API call.
//
// If you ever see 403/404 responses from downloadInstagramMedia(), the most
// likely cause is that the URL has already expired — NOT a missing auth token.
// However: if Meta changes this policy or you use the Graph API media endpoint
// (graph.facebook.com/v*/{{media-id}}?fields=url) instead of the raw CDN URL,
// you WILL need to add: Authorization: Bearer <META_IG_ACCESS_TOKEN>

'use strict';

const axios = require('axios');
const { normalizeInstagramMessage } = require('./normalizer');

const IG_VERIFY_TOKEN = process.env.META_IG_VERIFY_TOKEN;

// ─── Webhook Verification Handshake ──────────────────────────────────────────
// Meta sends a GET request with hub.challenge when you first subscribe a
// webhook. We must echo hub.challenge back to confirm ownership.
// Uses META_IG_VERIFY_TOKEN (separate from WhatsApp's META_VERIFY_TOKEN).

function handleVerification(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
    console.log('[instagram] Webhook verified successfully.');
    return res.status(200).send(challenge);
  }

  console.warn('[instagram] Webhook verification failed — token mismatch or missing mode.');
  return res.sendStatus(403);
}

// ─── Media Download ───────────────────────────────────────────────────────────
// Downloads an Instagram attachment from its pre-signed CDN URL.
//
// ⚠️  No Authorization header is needed for Messenger Platform CDN URLs.
//     See the auth note at the top of this file for details and caveats.
//
// Returns a Buffer, or throws on failure.

async function downloadInstagramMedia(url) {
  if (!url) throw new Error('[instagram] downloadInstagramMedia: url is required');

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    // No Authorization header — Messenger Platform CDN URLs are pre-signed.
    // If you switch to the Graph API media endpoint, add:
    //   headers: { Authorization: `Bearer ${process.env.META_IG_ACCESS_TOKEN}` }
    timeout: 15000, // 15 s — CDN is usually fast, but guard against hangs
  });

  return Buffer.from(response.data);
}

// ─── Webhook Event Handler ────────────────────────────────────────────────────
// Parses the Instagram Messenger Platform webhook payload and normalizes
// each messaging event. For now, only console.logs the result — no business
// logic is wired yet (same cautious step-by-step approach as WhatsApp Step 1).
//
// Expected payload shape:
//   req.body.object === "instagram"
//   req.body.entry[].messaging[].sender.id       (Instagram-scoped user ID)
//   req.body.entry[].messaging[].message.text    (text content)
//   req.body.entry[].messaging[].message.attachments[].type
//   req.body.entry[].messaging[].message.attachments[].payload.url
//   req.body.entry[].messaging[].timestamp       (Unix milliseconds)

async function handleWebhook(req, res) {
  const body = req.body;

  // Acknowledge immediately — Meta will retry if we don't respond within 20 s
  res.sendStatus(200);

  if (body.object !== 'instagram') return;

  for (const entry of (body.entry || [])) {
    for (const event of (entry.messaging || [])) {
      // Skip delivery confirmations, read receipts, and typing indicators —
      // they don't have a .message field.
      if (!event.message) continue;

      // Skip echo events (messages sent by the page itself)
      if (event.message.is_echo) continue;

      const senderId = event.sender?.id;
      if (!senderId) {
        console.warn('[instagram] Received messaging event with no sender.id — skipping.');
        continue;
      }

      try {
        const normalized = normalizeInstagramMessage(senderId, event);
        console.log(`\n📸 [instagram] ${senderId} [${normalized.type}]`);
        console.log('[instagram normalizer]', JSON.stringify(normalized, null, 2));

        // TODO (Step 2+): Wire into getSessionByKey() + business logic.
        // Example:
        //   const session = await getSessionByKey(normalized.sessionKey, 'instagram', senderId);
        //   ... route to handler based on normalized.type ...

      } catch (err) {
        console.error('[instagram] Webhook handler error:', err.message);
      }
    }
  }
}

module.exports = { handleWebhook, handleVerification, downloadInstagramMedia };
