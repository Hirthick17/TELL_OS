# AGENTS.md — TellOS Project Context for AI Agents

> **Purpose:** This file is the single source of truth for any AI coding agent (Claude, GPT, Gemini, etc.)
> working in this repository. Read this file first before reading any source file.
> It covers architecture, every file's responsibility, data contracts, extension points, and constraints.

---

## 1. Project Identity

| Field | Value |
|---|---|
| **Product name** | TellOS |
| **What it does** | WhatsApp-native AI business intelligence for small merchants — upload Excel, ask questions, get answers |
| **Primary channel** | Meta WhatsApp Cloud API (production) |
| **Secondary channel** | Instagram Messenger Platform (adapter built, routes not yet wired) |
| **Runtime** | Node.js + Express (`server.js`) |
| **Database** | MongoDB Atlas |
| **Primary AI** | Google Gemini 2.5 Flash (via `@google/generative-ai`) |
| **Secondary AI** | NVIDIA NIM / Llama 3.1 (via `openai` SDK, OpenAI-compatible endpoint) |
| **Entry point** | `npm start` → `node server.js` |
| **Deployment target** | Render.com / Railway.app |

---

## 2. Repository Map

```
TellOS_whatsapp_config/
│
├── server.js               ← Express app, ALL HTTP routes, top-level orchestration
├── llm.js                  ← Shared Gemini AI client (single instance — do not duplicate)
├── intelligence.js         ← Query planning, schema inference, OCR, NIM AI insights
├── intent-classifier.js    ← 3-layer intent classification engine
├── intent-router.js        ← Safety gates, pathway resolution, analytics data layer
├── missed-intents.js       ← Low-confidence intent logging + self-healing
├── sessions.js             ← MongoDB-backed session store (platform-agnostic)
├── db.js                   ← Full MongoDB data layer: CRUD, aggregation, indexes
├── parser.js               ← Excel/CSV parser with column type detection
├── meta-whatsapp.js        ← Meta WhatsApp Cloud API webhook handler
├── whatsapp.js             ← QR-code WhatsApp (local dev alternative, not Meta)
├── column-detector.js      ← Heuristic column semantic type detector
├── trace.js                ← Request tracing and structured logging
├── missed-intents.js       ← Missed intent queue management
├── webhook-test.js         ← Manual webhook testing utilities
├── check_keys.py           ← Python script for API key validation
│
├── adapters/
│   ├── normalizer.js       ← Platform-neutral message normalizer (WA + Instagram)
│   └── instagram.js        ← Instagram Messenger Platform webhook adapter (stub)
│
├── formatters/
│   └── whatsapp-formatter.js ← WhatsApp-specific reply formatter (*bold*, emojis)
│
├── public/
│   └── index.html          ← Web Chat UI (WhatsApp-style, served at GET /)
│
├── vendor/                 ← Vendored dependencies (if any)
├── Capture_V!/             ← Future Capture Layer prototype (IGNORE for now)
│
├── .env                    ← Real secrets — NEVER commit this file
├── .env.example            ← Placeholder template — safe to commit
├── .gitignore
├── package.json
├── pj.md                   ← TellOS architecture vision document (design reference)
└── AGENTS.md               ← This file
```

---

## 3. Architecture — Layer by Layer

### 3.1 High-Level Flow

```
WhatsApp / Web Chat / Instagram
          ↓
    server.js (Express)
          ↓
    meta-whatsapp.js (for WA webhook)
          ↓
    sessions.js → getSessionByKey()
          ↓
    intent-classifier.js → classifyIntent()
          ↓
    intent-router.js → routePathway()
         / \
        /   \
       ↓     ↓
DATA_INGESTION  DATA_ANALYTICS
(intelligence.js)  (intent-router.js + db.js)
       ↓               ↓
    db.js          formatters/whatsapp-formatter.js
       ↓               ↓
    MongoDB      WhatsApp reply sent
```

### 3.2 Layer Responsibilities

| Layer | Files | Responsibility |
|---|---|---|
| **Transport** | `meta-whatsapp.js`, `whatsapp.js`, `adapters/instagram.js` | Receive raw webhook payloads, download media, send replies |
| **Normalization** | `adapters/normalizer.js` | Convert platform-specific payloads → platform-neutral `{platform, senderId, sessionKey, type, text, mediaId, fileName, timestamp, raw}` |
| **Session** | `sessions.js` | Maintain per-user state: conversation history, dataset context, active flows |
| **Routing** | `intent-classifier.js` → `intent-router.js` | Classify intent, apply safety gates, route to correct handler |
| **Intelligence** | `intelligence.js` | Query planning, schema inference, Gemini OCR, NIM insights |
| **Data** | `db.js` | All MongoDB operations: CRUD, aggregation queries, index management |
| **Parsing** | `parser.js`, `column-detector.js` | Parse Excel/CSV, detect column semantic types |
| **Formatting** | `formatters/whatsapp-formatter.js` | Convert structured analytics data → WhatsApp-formatted strings |
| **Presentation** | `public/index.html` | Web chat UI |
| **Observability** | `trace.js`, `missed-intents.js` | Logging, tracing, low-confidence intent capture |

---

## 4. File-by-File Reference

### `server.js`
- **Role:** The entire Express app lives here. All route registrations. All HTTP middleware.
- **Key routes:**
  - `GET /` → Web chat UI
  - `POST /chat` → Web UI message handler
  - `POST /upload` → Excel/image file upload
  - `POST /upload/confirm` → Stream-insert confirmed data to MongoDB
  - `GET /dashboard/:id` → Live merchant dashboard HTML
  - `GET /api/stats/:id` → Dashboard data JSON
  - `GET|POST /webhook` → Meta WhatsApp webhook (verify + events)
  - `GET /health` → DB + Gemini + NIM status
  - `GET /api/missed-intents` → Admin: view low-confidence logs
- **Important:** All heavy processing (batch inserts, AI calls) is done **async** after `res.send()` — the WhatsApp webhook must get a 200 within 15 seconds.

---

### `llm.js`
- **Role:** Single shared Gemini AI client. Import `{ gemini }` — do not create new `GoogleGenerativeAI` instances elsewhere.
- **Exports:** `{ gemini, generateContent, generateJSON }`
- **Model:** `gemini-2.5-flash` (configurable via env)
- **Pattern:** All Gemini calls go through this file. This allows easy model switching and retry logic.

---

### `intelligence.js`
- **Role:** The "brain" of TellOS. All complex AI reasoning.
- **Key functions:**
  - `planQuery(session, userMessage)` → calls Gemini to produce a MongoDB aggregation plan
  - `inferSchema(columns, sampleRows)` → LLM-based column semantic profiling
  - `extractTableFromImage(imageBuffer)` → Gemini Vision OCR for photos of registers/receipts
  - `generateInsights(datasetId, records)` → NIM/Llama3.1 generates business narrative insights
  - `buildResultsContext(queryResult, session)` → formats raw DB results for conversational LLM reply
- **AI models used:** Gemini (primary), NIM Llama 3.1 (insights only)

---

### `intent-classifier.js`
- **Role:** 3-layer intent classification.
- **Layer 1 — Hard gates (regex/rule-based):** Checks for active upload flows, greetings, safety blocks. Returns instantly without an LLM call.
- **Layer 2 — Gemini JSON classifier:** Returns `{ intent, confidence, reasoning }`. Intents: `DATA_ANALYTICS`, `DATA_INGESTION`, `CLARIFICATION`, `OFF_TOPIC`.
- **Layer 3 — Fallback router:** Keyword/regex fallback when Gemini fails or confidence < 0.65.
- **Key rule:** If the **fallback router** fires (Layer 3), its confidence is trusted directly — do not re-evaluate against the LLM threshold. This was intentionally designed to prevent "clarification loop" bugs.
- **Exports:** `{ classifyIntent }`

---

### `intent-router.js`
- **Role:** Routes classified intents to the correct handler + contains the analytics data computation layer.
- **Key functions:**
  - `routePathway(session, message, classification)` → dispatches to handler
  - `buildAnalyticsData(intent_id, data)` → returns platform-neutral `{ title, rows: [{label, value}] }` — NO markup
  - `formatAnalyticsReply(intent_id, data)` → compatibility wrapper: calls `buildAnalyticsData` then `formatForWhatsApp`
- **Analytics intents (11 total):** `top_products`, `low_stock`, `total_revenue`, `pending_orders`, `dead_inventory`, `avg_order_value`, `top_customers`, `repeat_customers`, `best_day`, `best_category`, `order_timing`
- **Important:** `formatAnalyticsReply()` is the public API. Never remove it — existing callers depend on it.

---

### `sessions.js`
- **Role:** Platform-agnostic session store. Hybrid: in-memory Map (fast) + MongoDB (persistent across restarts).
- **Session shape:**
  ```js
  {
    sessionId,       // UUID
    phoneNumber,     // WhatsApp number (kept for sending WA replies)
    sessionKey,      // "whatsapp:919999..." or "instagram:12345..." — the lookup key
    channel,         // "whatsapp" | "instagram" | "web"
    messages: [],    // Conversation history [{role, text, time}]
    datasetId,       // Current active dataset
    datasetSchema,   // Column profiles
    uploadState,     // null | "awaiting_confirmation" | "processing"
    pendingUpload,   // Temp storage for unconfirmed uploads
  }
  ```
- **Key functions:**
  - `getSessionByKey(sessionKey, channel, rawId)` → primary lookup (platform-agnostic)
  - `getSessionByPhone(phoneNumber)` → compatibility wrapper, calls `getSessionByKey('whatsapp:'+phone, 'whatsapp', phone)`
  - `saveSession(session)` → persists to MongoDB
  - `updateSession(sessionKey, updates)` → partial update helper

---

### `db.js`
- **Role:** All MongoDB operations. No business logic here — pure data layer.
- **Collections:**
  - `sessions` — session state (indexed on `sessionKey` and `phoneNumber`)
  - `datasets` — dataset metadata per user (name, schema, column profiles)
  - `dataset_records` — actual merchant data rows (indexed on `datasetId`)
  - `dataset_metadata` — dataset-level stats and AI-generated insights
  - `dataset_insights` — NIM-generated narrative insights per dataset
  - `missed_intents` — low-confidence intent logs for self-healing
- **Key functions:**
  - `insertRecords(datasetId, rows)` — batch insert in 200-row chunks
  - `runAggregation(datasetId, pipeline)` — executes MongoDB aggregation
  - `getDatasetSchema(datasetId)` — returns column profiles
  - `createIndexes()` — called at startup; ensures indexes exist (idempotent)
- **Indexes:**
  - `sessions`: `{ phoneNumber: 1 }`, `{ sessionKey: 1 }` (sparse)
  - `dataset_records`: `{ datasetId: 1 }`, `{ datasetId: 1, createdAt: -1 }`

---

### `meta-whatsapp.js`
- **Role:** Meta WhatsApp Cloud API integration.
- **Key functions:**
  - `handleVerification(req, res)` — GET webhook handshake
  - `handleWebhook(req, res)` — POST webhook: parses messages, downloads media, dispatches to session handler
  - `downloadMedia(mediaId)` — exchanges Media ID for URL then downloads binary
  - `sendMessage(to, text)` — sends text reply via Cloud API
  - `sendMediaMessage(to, url, caption)` — sends media reply
- **Critical constraint:** Must `res.sendStatus(200)` within **15 seconds**. All heavy work goes in `setImmediate()` / async after response.
- **Media flow:** `mediaId` → Graph API `/media/{id}` to get URL → GET URL with Bearer token → Buffer
- **Normalization hook:** Calls `normalizeWhatsAppMessage(waId, msg, hostUrl)` from `adapters/normalizer.js` for debug logging (business logic not yet wired to normalized object).

---

### `adapters/normalizer.js`
- **Role:** Platform-neutral message translation layer.
- **Exports:**
  - `normalizeWhatsAppMessage(waId, msg, hostUrl)` — converts WhatsApp webhook `messages[]` item
  - `normalizeInstagramMessage(senderId, event)` — converts Instagram `messaging[]` event
- **Output shape (both functions):**
  ```js
  {
    platform,    // "whatsapp" | "instagram"
    senderId,    // platform-scoped user ID
    sessionKey,  // "whatsapp:{id}" | "instagram:{id}"
    type,        // "text" | "image" | "document" | "unsupported"
    text,        // string | null
    mediaId,     // WA: opaque media ID | IG: CDN URL | null
    fileName,    // string | null (always null for Instagram)
    timestamp,   // Unix milliseconds
    raw,         // original platform event object
  }
  ```
- **Key difference — timestamps:** WhatsApp sends Unix seconds (× 1000 to get ms). Instagram sends Unix milliseconds directly.
- **Key difference — media:** WhatsApp `mediaId` must be resolved via an API call. Instagram `mediaId` IS the CDN URL — download directly (no auth header needed, but URL expires within minutes).

---

### `adapters/instagram.js`
- **Role:** Instagram Messenger Platform webhook adapter. Mirrors `meta-whatsapp.js` structure.
- **Status:** Built but **not yet wired into Express routes** in `server.js`. Intentionally stub-only.
- **Exports:** `{ handleWebhook, handleVerification, downloadInstagramMedia }`
- **Env vars needed:** `META_IG_VERIFY_TOKEN`, `META_IG_ACCESS_TOKEN` (optional, for Graph API media only)
- **To wire up:** Add to `server.js`:
  ```js
  const ig = require('./adapters/instagram');
  app.get('/webhook/instagram',  ig.handleVerification);
  app.post('/webhook/instagram', ig.handleWebhook);
  ```
- **Auth note:** `downloadInstagramMedia(url)` does NOT need an Authorization header for Messenger Platform CDN URLs (they are pre-signed). If switching to Graph API endpoint, add `Authorization: Bearer <META_IG_ACCESS_TOKEN>`.

---

### `formatters/whatsapp-formatter.js`
- **Role:** WhatsApp-specific presentation. Takes platform-neutral structured data, returns `*bold*` + emoji strings.
- **Exports:** `{ formatForWhatsApp }`
- **Signature:** `formatForWhatsApp(intent_id, structured)` where `structured = { title, rows: [{label, value}] }`
- **Handles all 11 analytics intents.** Returns `null` for unknown or `growth_advice`.
- **To add a new platform formatter:** Create `formatters/telegram-formatter.js` with the same interface. Do not modify this file.

---

### `parser.js`
- **Role:** Excel/CSV parsing. Uses SheetJS (`xlsx`). Zero disk writes — processes Buffer in memory.
- **Exports:** `{ parseFile }`
- **Returns:** `{ columns: string[], rows: object[], totalRows: number, sheetName: string }`
- **Handles:** `.xlsx`, `.xls`, `.csv`, `.ods`

---

### `column-detector.js`
- **Role:** Heuristic semantic type detection for column names.
- **Semantic types detected:** `PRODUCT`, `QUANTITY`, `REVENUE`, `DATE`, `CUSTOMER`, `ORDER_ID`, `STATUS`, `CATEGORY`, `PRICE`, `COST`
- **Used by:** `intelligence.js` during schema inference to seed LLM with hints

---

### `trace.js`
- **Role:** Structured logging and request tracing. Wraps `console.log` with context (session ID, timestamp, elapsed time).
- **Exports:** `{ createTrace, logStep, endTrace }`
- **Usage:** Create a trace at request start, log steps through the pipeline, end at response.

---

### `missed-intents.js`
- **Role:** Captures messages where classifier had low confidence (`< 0.65`) or conflicting signals.
- **Stores in:** MongoDB `missed_intents` collection
- **Self-healing:** If a later message for the same user gets correctly classified, it backfills the earlier log — creating real-world training data.
- **Admin endpoint:** `GET /api/missed-intents` (requires `ADMIN_SECRET` header)

---

## 5. Data Contracts

### Session Object (in-memory + MongoDB)
```js
{
  _id,               // MongoDB ObjectId
  sessionId,         // UUID string
  phoneNumber,       // "+919999999999" — kept for WhatsApp reply routing
  sessionKey,        // "whatsapp:919999999999" — primary lookup key
  channel,           // "whatsapp" | "instagram" | "web"
  messages: [        // conversation history
    { role: "user"|"bot", text: string, time: number }
  ],
  datasetId,         // MongoDB ObjectId | null
  datasetName,       // string | null
  datasetSchema: [], // column profile objects
  uploadState,       // null | "awaiting_confirmation" | "processing" | "complete"
  pendingUpload,     // { columns, rows, totalRows } | null
  createdAt,
  updatedAt,
}
```

### Normalized Message Object (from `adapters/normalizer.js`)
```js
{
  platform,    // "whatsapp" | "instagram"
  senderId,    // string
  sessionKey,  // "whatsapp:{id}" | "instagram:{id}"
  type,        // "text" | "image" | "document" | "unsupported"
  text,        // string | null
  mediaId,     // string | null
  fileName,    // string | null
  timestamp,   // number (Unix ms)
  raw,         // original platform object
}
```

### Analytics Structured Data (from `buildAnalyticsData`)
```js
{
  title: string,          // e.g. "Top Products"
  rows: [
    { label: string, value: string }
  ],
  // Optional:
  empty: boolean,
  emptyMessage: string,
  totalCount: number,
  isTop: boolean,
}
```

### Dataset Record (in MongoDB `dataset_records`)
```js
{
  _id,
  datasetId,    // ObjectId — foreign key to datasets collection
  createdAt,
  ...           // all original merchant data columns as-is
}
```

---

## 6. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key |
| `NIM_KEY` | ✅ | NVIDIA NIM API key (Llama 3.1) |
| `META_ACCESS_TOKEN` | ✅ | Meta WhatsApp Cloud API token |
| `META_PHONE_NUMBER_ID` | ✅ | WhatsApp Business phone number ID |
| `META_VERIFY_TOKEN` | ✅ | Webhook verification token (any string you choose) |
| `MONGO_URL` | ✅ | MongoDB connection string |
| `PUBLIC_URL` | ✅ | Deployed server URL (used in dashboard links sent via WA) |
| `ADMIN_SECRET` | Optional | Header token for admin endpoints |
| `TRACE_MODE` | Optional | `true` to enable verbose step logging |
| `META_IG_VERIFY_TOKEN` | Optional | Instagram webhook verify token (needed when IG routes wired) |
| `META_IG_ACCESS_TOKEN` | Optional | Instagram Graph API token (needed for Graph API media downloads) |
| `PORT` | Optional | HTTP port (default: 3000) |

---

## 7. Key Architectural Decisions & Constraints

### 7.1 WhatsApp Hard Constraints
- **15-second webhook timeout:** `res.sendStatus(200)` MUST fire immediately. All AI processing runs async afterward.
- **Media URL expiry:** Meta media URLs expire in ~5 minutes. Download to Buffer immediately on receipt.
- **No markdown:** WhatsApp uses `*bold*`, `_italic_`, `~strikethrough~` — NOT `**bold**`.
- **Reply length:** Keep replies short and scannable. Aim for <5 lines per message.

### 7.2 Session Lookup — Use `sessionKey`, Not `phoneNumber`
The session store was refactored to be platform-agnostic. Always use:
```js
getSessionByKey(sessionKey, channel, rawId)
// e.g. getSessionByKey("whatsapp:919999999999", "whatsapp", "919999999999")
```
`getSessionByPhone()` is a backward-compat wrapper and still works for WhatsApp.

### 7.3 Never Put Business Logic in the Capture/Normalizer Layer
`adapters/normalizer.js` is platform translation only. It must not interpret domain meaning (what the document IS about). That belongs in `intelligence.js` and downstream.

### 7.4 `formatAnalyticsReply()` Is a Public API
Do not rename or remove `formatAnalyticsReply(intent_id, data)` in `intent-router.js`. It is the stable interface that all callers use. The decoupled `buildAnalyticsData()` / `formatForWhatsApp()` are implementation details.

### 7.5 Gemini Is the Last-Resort Parser, Not the First Tool
Routing priority: `Deterministic → Specialized ML → Gemini/LLM → Human review`.
Use Gemini only when lower-cost methods fail or confidence is too low.

### 7.6 All Originals Are Preserved
Never overwrite raw input. The `raw` field in normalized messages and raw files should always be kept for debugging and provenance.

---

## 8. Extension Points

### Adding a New Messaging Platform
1. Create `adapters/{platform}.js` — mirror `adapters/instagram.js` structure
2. Export `handleWebhook`, `handleVerification`
3. Add `normalize{Platform}Message(senderId, event)` to `adapters/normalizer.js`
4. Add route in `server.js`: `app.get('/webhook/{platform}', ...)` and `app.post(...)`
5. Add env var `META_{PLATFORM}_VERIFY_TOKEN`

### Adding a New Analytics Intent
1. Add the intent keyword signals to `ANALYTICS_INTENT_SIGNALS` in `intent-classifier.js`
2. Add a `case '{intent_id}':` block in `buildAnalyticsData()` in `intent-router.js` — return `{ title, rows }`
3. Add a `case '{intent_id}':` block in `formatForWhatsApp()` in `formatters/whatsapp-formatter.js` — return formatted string

### Adding a New Platform Formatter
1. Create `formatters/{platform}-formatter.js`
2. Export `{ formatFor{Platform}(intent_id, structured) }`
3. The `structured` input shape is `{ title, rows: [{label, value}] }` — same as `buildAnalyticsData` output
4. Import and call from the platform's reply handler

### Adding a New Column Semantic Type
1. Add the type to the heuristic matcher in `column-detector.js`
2. Add handling in `intelligence.js` schema inference prompt
3. Add handling in `db.js` aggregation pipeline builder

---

## 9. Known Issues & Gotchas

| Issue | Detail |
|---|---|
| **MongoDB connection timeout** | Seen in logs: "Session save error: Server selection timed out after 5000 ms". Usually transient Atlas networking. The in-memory session still works; only persistence fails. |
| **Instagram routes not wired** | `adapters/instagram.js` exists and is complete but Express routes not added to `server.js` yet. See section 4 → `adapters/instagram.js`. |
| **WhatsApp normalization diagnostic only** | `normalizeWhatsAppMessage()` is called in `meta-whatsapp.js` and logged, but the normalized object is not yet used for routing — existing direct field access still drives the logic. |
| **`whatsapp.js` is local dev only** | Uses `whatsapp-web.js` (QR code scan). Not for production. Production uses `meta-whatsapp.js`. |
| **`Capture_V!/` directory** | Ignore this directory — it is a future prototype and not part of the current working system. |

---

## 10. Vision Context (from `pj.md`)

TellOS is designed to eventually become **two independent infrastructure products**:

```
TELLOS CORE
│
├── Capture Infrastructure      ← Physical world → reliable machine-readable input
│   (not yet built — see pj.md)
│
└── Context Infrastructure      ← Machine-readable input → reliable business state
    (current codebase implements this for WhatsApp + Excel)
```

Then **Industry Packs** (e.g., Textile Pack, Retail Pack) sit above them.

Then **RAG / Agents / Applications** consume that context.

**The current WhatsApp codebase is the Context Infrastructure MVP** — specifically for Excel data uploaded via WhatsApp, with AI-powered analytics on top.

The platform-neutral adapter layer (`adapters/`, `formatters/`) is the first step toward making this multi-channel.

---

*Last updated: 2026-09-01. Update this file whenever core architectural decisions change.*
