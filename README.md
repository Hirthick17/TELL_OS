# TELL_OS — WhatsApp Ecommerce Assistant

A WhatsApp-based AI chatbot that helps small businesses and D2C sellers manage their store data through natural conversation.

## What It Does

1. **Chat via WhatsApp** — AI-powered bot explains the service and guides users
2. **Upload Excel** — Send a `.xlsx` file; bot identifies Products, Orders, Inventory, Payments
3. **Preview before storing** — Bot summarizes what it found, asks confirmation
4. **Live Dashboard** — After confirming, a real-time dashboard URL is sent to WhatsApp
5. **Multi-user** — Each phone number gets an isolated session and private dashboard

## Tech Stack

- **Node.js + Express** — Backend server
- **Gemini 2.5 Flash** — AI conversations
- **MongoDB** — Data storage (products, orders, inventory, payments, sessions)
- **Meta WhatsApp Cloud API** — Official WhatsApp integration
- **xlsx** — Excel file parsing

## Project Structure

```
server.js          — Express server, all HTTP routes
llm.js             — Shared Gemini AI setup (single source of truth)
sessions.js        — MongoDB-backed session store (survives restarts)
db.js              — MongoDB data layer
parser.js          — Excel file parser (auto-detects sheet types)
meta-whatsapp.js   — Meta WhatsApp Cloud API webhook handler
whatsapp.js        — QR-code based WhatsApp (alternative)
public/index.html  — Web chat UI (WhatsApp-style)
create-sample-excel.js — Generate test data
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
Copy `.env.example` to `.env` and fill in:
```env
GEMINI_API_KEY=AIzaSy...          # From aistudio.google.com
META_PHONE_NUMBER_ID=             # From Meta Developer Portal
META_ACCESS_TOKEN=                # From Meta Developer Portal
META_VERIFY_TOKEN=shopbot_verify_2024
MONGO_URL=mongodb://localhost:27017
PUBLIC_URL=https://your-deployed-url.com
```

### 3. Start the server
```bash
npm start
```

### 4. Test locally
```
http://localhost:3000          — Chat UI
http://localhost:3000/health   — Health check
http://localhost:3000/dashboard/{sessionId} — Live dashboard
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | DB + Gemini status check |
| POST | `/chat` | Send message to AI bot |
| POST | `/upload` | Upload Excel file |
| GET | `/dashboard/:id` | Live data dashboard |
| GET | `/api/stats/:id` | Dashboard JSON data |
| GET | `/session/:id/messages` | Restore chat history |
| GET | `/webhook` | Meta webhook verification |
| POST | `/webhook` | Meta incoming messages |

## Deployment

Designed for Railway.app deployment. See `deployment_guide.md` for full instructions.

## License

MIT
