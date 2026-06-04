// webhook-test.js — Full diagnostic + webhook simulation
// Usage: node webhook-test.js
// Checks all failure points and simulates an inbound WhatsApp message

require('dotenv').config();
const axios = require('axios');

const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN || 'shopbot_verify_2024';
const PUBLIC_URL      = process.env.PUBLIC_URL || 'http://localhost:3000';
const API_VER         = 'v20.0';

// ─── Colors ───────────────────────────────────────────────────────────────
const OK   = (s) => `\x1b[32m✅ ${s}\x1b[0m`;
const FAIL = (s) => `\x1b[31m❌ ${s}\x1b[0m`;
const WARN = (s) => `\x1b[33m⚠️  ${s}\x1b[0m`;
const INFO = (s) => `\x1b[36mℹ️  ${s}\x1b[0m`;
const HEAD = (s) => `\n\x1b[1m\x1b[35m━━━ ${s} ━━━\x1b[0m`;

async function run() {
  console.log('\n🔍  ShopBot Webhook Diagnostic\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. ENV VARS CHECK
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('1. Environment Variables'));

  const checks = {
    GEMINI_API_KEY:    process.env.GEMINI_API_KEY,
    META_ACCESS_TOKEN: ACCESS_TOKEN,
    META_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    MONGO_URL:         process.env.MONGO_URL,
    PUBLIC_URL:        process.env.PUBLIC_URL,
  };

  let envOk = true;
  for (const [key, val] of Object.entries(checks)) {
    if (!val || val.startsWith('your_') || val.includes('your_key')) {
      console.log(FAIL(`${key} — MISSING or placeholder`));
      envOk = false;
    } else {
      const masked = val.length > 12 ? val.slice(0, 6) + '…' + val.slice(-4) : val;
      console.log(OK(`${key} = ${masked}`));
    }
  }

  if (!envOk) {
    console.log(WARN('\nFix .env file first. Copy .env.example → .env and fill in real values.\n'));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. META ACCESS TOKEN VALIDITY
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('2. Meta Access Token'));

  if (!ACCESS_TOKEN || ACCESS_TOKEN.startsWith('your_')) {
    console.log(FAIL('Cannot test — token missing'));
  } else {
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${API_VER}/me`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 8000 }
      );
      console.log(OK(`Token valid — App: ${data.name || data.id}`));
    } catch (err) {
      const code    = err.response?.data?.error?.code;
      const msg     = err.response?.data?.error?.message || err.message;
      const subcode = err.response?.data?.error?.error_subcode;
      console.log(FAIL(`Token invalid — ${msg}`));
      if (code === 190) {
        console.log(INFO('  Code 190 = expired/invalid token.'));
        console.log(INFO('  Fix: Go to Meta for Developers → WhatsApp → API Setup → Generate new token'));
        console.log(INFO('  Or use a System User permanent token: https://developers.facebook.com/docs/whatsapp/business-management-api/get-started'));
      }
      if (subcode === 463) console.log(INFO('  Subcode 463 = token expired. Refresh it.'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. PHONE NUMBER ID CHECK
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('3. Phone Number ID'));

  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || ACCESS_TOKEN.startsWith('your_')) {
    console.log(FAIL('Cannot test — token or phone ID missing'));
  } else {
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${API_VER}/${PHONE_NUMBER_ID}`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 8000 }
      );
      console.log(OK(`Phone ID valid — display name: "${data.display_phone_number || data.id}"`));
      console.log(OK(`  Verified name: ${data.verified_name || '(none)'}`));
      console.log(OK(`  Status: ${data.code_verification_status || 'unknown'}`));
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.log(FAIL(`Phone Number ID check failed — ${msg}`));
      console.log(INFO('  Verify PHONE_NUMBER_ID in Meta Developer Console → WhatsApp → Getting Started'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. LOCAL SERVER HEALTH
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('4. Local Server Health'));

  try {
    const { data } = await axios.get('http://localhost:3000/health', { timeout: 5000 });
    console.log(OK(`Server up — DB: ${data.db}, Gemini: ${data.gemini}, Uptime: ${data.uptime}`));
  } catch (err) {
    console.log(FAIL(`Server not reachable at localhost:3000 — ${err.message}`));
    console.log(INFO('  Start with: npm start  (or node server.js)'));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. WEBHOOK GET VERIFICATION (local)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('5. Webhook GET Verification (local)'));

  try {
    const { data, status } = await axios.get('http://localhost:3000/webhook', {
      params: {
        'hub.mode':         'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge':    'CHALLENGE_ACCEPTED',
      },
      timeout: 5000,
    });
    if (status === 200 && data === 'CHALLENGE_ACCEPTED') {
      console.log(OK(`Webhook verification works — returned challenge correctly`));
    } else {
      console.log(FAIL(`Unexpected response: status=${status}, body=${JSON.stringify(data)}`));
    }
  } catch (err) {
    console.log(FAIL(`Webhook GET failed — ${err.message}`));
    console.log(INFO('  Make sure server is running and GET /webhook is registered'));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. SIMULATE INBOUND WHATSAPP MESSAGE (POST /webhook)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('6. Simulate Inbound WhatsApp Message (POST /webhook)'));

  const testPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'TEST_ENTRY',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15550000000',
            phone_number_id: PHONE_NUMBER_ID || 'TEST_PHONE_ID',
          },
          contacts: [{ profile: { name: 'Test User' }, wa_id: '919999999999' }],
          messages: [{
            from: '919999999999',
            id: 'wamid.TEST123',
            timestamp: Math.floor(Date.now() / 1000).toString(),
            text: { body: 'Hello ShopBot! This is a webhook test.' },
            type: 'text',
          }],
        },
      }],
    }],
  };

  try {
    const { status } = await axios.post('http://localhost:3000/webhook', testPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    if (status === 200) {
      console.log(OK(`POST /webhook accepted (200). Message handler triggered.`));
      console.log(INFO('  Check server console for "📨 919999999999 [text]" log'));
      console.log(INFO('  If token is valid, a reply was sent via Meta API to 919999999999'));
    } else {
      console.log(FAIL(`Unexpected status: ${status}`));
    }
  } catch (err) {
    console.log(FAIL(`POST /webhook failed — ${err.message}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. PUBLIC URL REACHABILITY (for Meta to call your webhook)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('7. Public URL Reachability'));

  if (!process.env.PUBLIC_URL || process.env.PUBLIC_URL.includes('localhost')) {
    console.log(WARN('PUBLIC_URL is localhost — Meta cannot reach this from the internet!'));
    console.log(INFO('  Options:'));
    console.log(INFO('  A) Deploy to Render/Railway/Fly.io and set PUBLIC_URL to your deployment URL'));
    console.log(INFO('  B) Use ngrok for local testing: npx ngrok http 3000'));
    console.log(INFO('     Then set PUBLIC_URL=https://xxxx.ngrok-free.app in .env'));
    console.log(INFO('     And re-register your webhook in Meta Developer Console'));
  } else {
    try {
      const { data } = await axios.get(`${process.env.PUBLIC_URL}/health`, { timeout: 8000 });
      console.log(OK(`Public URL reachable: ${process.env.PUBLIC_URL}`));
      console.log(INFO(`  DB: ${data.db}, Gemini: ${data.gemini}`));
    } catch (err) {
      console.log(FAIL(`Public URL not reachable: ${process.env.PUBLIC_URL} — ${err.message}`));
      console.log(INFO('  Check your deployment is live and PUBLIC_URL is correct'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. META WEBHOOK REGISTRATION STATUS
  // ──────────────────────────────────────────────────────────────────────────
  console.log(HEAD('8. Meta Webhook Registration'));

  if (!ACCESS_TOKEN || ACCESS_TOKEN.startsWith('your_')) {
    console.log(FAIL('Cannot check — token missing'));
  } else {
    try {
      // Get the app subscriptions
      const { data } = await axios.get(
        `https://graph.facebook.com/${API_VER}/me/subscribed_apps`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 8000 }
      );
      if (data.data && data.data.length > 0) {
        console.log(OK(`Subscribed apps found: ${JSON.stringify(data.data)}`));
      } else {
        console.log(WARN('No subscribed apps found — webhook may not be registered'));
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.log(WARN(`Could not check subscriptions: ${msg}`));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('📋  COMMON FAILURE POINTS & FIXES');
  console.log('═'.repeat(60));
  console.log(`
1. TOKEN EXPIRED  → Generate new token in Meta Developer Console
   Meta for Developers → Your App → WhatsApp → API Setup
   Copy the "Temporary access token" (valid 24h) OR
   Create a System User token (permanent):
   Business Settings → System Users → Add → Generate Token

2. WRONG PHONE NUMBER ID  → Check Meta → WhatsApp → Getting Started
   It's the numeric ID like "123456789012345"

3. WEBHOOK NOT REGISTERED  → Go to Meta → WhatsApp → Configuration
   Callback URL: https://your-domain.com/webhook
   Verify Token: ${VERIFY_TOKEN}
   Subscribe to: messages

4. SERVER NOT PUBLIC  → Use Render/Railway deployment OR ngrok:
   npx ngrok http 3000
   Use the https://xxxx.ngrok-free.app URL as your webhook

5. NUMBER NOT IN TEST WHITELIST  → Meta sandbox only allows numbers
   you've added. Go to Meta → WhatsApp → Getting Started →
   "To" field → add your WhatsApp number → click Send Message

6. MESSAGE OUTSIDE 24H WINDOW  → You can only send free-form messages
   within 24h of last user-initiated message. Use a template otherwise.
`);
}

run().catch(err => console.error('Fatal error:', err.message));
