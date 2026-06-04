// llm.js — Shared Gemini LLM setup, reused by server.js and meta-whatsapp.js
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL  = 'gemini-2.5-flash';

// ─── System prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are ShopBot, a friendly WhatsApp ecommerce assistant for small businesses and D2C sellers in India.

Your core service:
- Help sellers manage products, orders, inventory, and payment data via Excel upload
- Give them a live dashboard URL after upload to monitor their business in real-time
- Everything through WhatsApp — no complex tools needed

Conversation flow:
1. Warmly greet, explain what you do in 1-2 sentences
2. Ask what they need. Validate their problem, show you understand, ask permission to help
3. If they mention data/products/orders/inventory → tell them to send an Excel file (.xlsx)
4. After file scanned: show data summary, ask "Should I store this? Reply Yes or No"
5. On Yes: store in DB → send dashboard URL
6. On confirm/activate: send warm welcome message

Style: SHORT (2-4 lines), conversational WhatsApp tone, use emojis naturally, never formal.
Pricing: "Let's set up your data first, then we can talk pricing! 😊"`;

// ─── Build Gemini history with system prompt as first exchange ────────────
// Injecting as history is compatible with ALL Gemini model versions.
function buildHistory(userHistory = []) {
  return [
    { role: 'user',  parts: [{ text: `[SYSTEM INSTRUCTIONS]\n${SYSTEM_PROMPT}` }] },
    { role: 'model', parts: [{ text: 'Understood! Ready to help as ShopBot.' }] },
    ...userHistory,
  ];
}

// ─── Send a chat message via Gemini ──────────────────────────────────────
// contextNote: optional string prepended to the user message (session state hints)
// history:     session.history array (role/parts format)
// Returns: reply string
async function chat(message, history = [], contextNote = '') {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY not configured. Add it to .env and restart.');
  }

  const model      = genAI.getGenerativeModel({ model: MODEL });
  const fullMsg    = contextNote ? `${contextNote} User: ${message}` : message;
  const chatClient = model.startChat({ history: buildHistory(history) });
  const result     = await chatClient.sendMessage(fullMsg);
  return result.response.text().trim();
}

module.exports = { chat, buildHistory, SYSTEM_PROMPT, MODEL };
