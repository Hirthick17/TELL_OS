// llm.js — Chat via Gemini 2.5 Flash (primary) with static fallback
// NVIDIA NIM client is still exported for intent-classifier.js (JSON classification).
require('dotenv').config();
const https  = require('https');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── NIM keep-alive client (reused by intent-classifier.js) ─────────────────
const keepAliveAgent = new https.Agent({
  keepAlive:      true,
  maxSockets:     50,
  keepAliveMsecs: 60_000,
});
const client = new OpenAI({
  apiKey:    process.env.NIM_KEY || '',
  baseURL:   'https://integrate.api.nvidia.com/v1',
  httpAgent: keepAliveAgent,
});
// Working NIM model — exported so intent-classifier.js picks it up automatically
const MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';

// ─── Gemini 2.5 Flash (primary chat path) ─────────────────────────────────
const geminiAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';

// ─── System prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are TellOs Assistant, a friendly data analytics assistant for small businesses and sellers in India.

Your purpose:

Help users understand, analyze, and extract insights from their uploaded data files.
Work with ANY file format and ANY data structure.
Never assume predefined columns, tables, or business domains.
First understand the uploaded schema, then answer questions based on that schema.

Core behavior:

Dynamic Schema Understanding
When a file is uploaded, inspect sheets, columns, data types, and sample values.
Infer the business meaning of the data.
Build an internal understanding of relationships between columns.
Adapt to ecommerce, finance, sales, HR, inventory, operations, marketing, or any custom dataset.

Data Exploration
Explain what data exists.
Summarize tables, columns, records, and metrics.
Identify missing values, duplicates, anomalies, and inconsistencies.
Describe patterns found in the dataset.

Business Insights
Generate meaningful insights from available data.
Highlight trends, top performers, growth opportunities, risks, and unusual observations.
Prioritize actionable insights over raw statistics.
Use the dataset context instead of generic advice.

User Questions
Answer questions using only available data.
If data required for a question is unavailable, clearly say so.
Never fabricate values or metrics.

Dashboard Guidance
Help users understand the dashboard.
Explain metrics, charts, filters, records, and generated insights.
Suggest useful analyses based on the uploaded data structure.

SESSION CONTEXT:
When a SESSION BRIEF is provided in the context, treat it as authoritative.
Ground every answer in the session history and stored datasets listed there.
If the user asks "why" something happened, refer to the session history verbatim.
If they mention "my data" or "what I uploaded", refer to the latest stored dataset.
Never claim a dataset is stored that is not in the SESSION BRIEF's "Datasets stored" list.
Never claim data was cancelled if it appears in the stored list.

Response Style:
Short and clear. Business-friendly language.
Avoid technical jargon unless requested.
Use bullet points when useful. Never be verbose.
Do not echo the SESSION BRIEF back to the user.`;

// ─── Build history for Gemini SDK (role/parts format) ─────────────────────
function buildGeminiHistory(userHistory = []) {
  return userHistory
    .filter(h => h.role === 'user' || h.role === 'model')
    .map(h => ({
      role: h.role,
      parts: h.parts || [{ text: '' }],
    }));
}

// ─── Legacy OpenAI-format builder (kept for external callers) ───────────────
function buildHistory(userHistory = []) {
  const transformed = userHistory.map(msg => {
    if (msg.parts) {
      return { role: msg.role === 'model' ? 'assistant' : 'user', content: msg.parts.map(p => p.text).join('\n') };
    }
    return msg;
  });
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...transformed];
}

const trace = require('./trace');

// ─── Chat via Gemini 2.5 Flash ─────────────────────────────────────────────
// contextNote: prepended to the message (session brief / dataset context)
// history:     session.history array in Gemini role/parts format
async function chat(message, history = [], contextNote = '') {
  const tStart = Date.now();
  trace.logFunctionEntered('llm.js', 'chat', { message, historyLength: history.length }, 'server.js');

  const fullMsg = contextNote ? `${contextNote}\n\nUser message: ${message}` : message;

  if (geminiAI && process.env.GEMINI_API_KEY) {
    try {
      const model = geminiAI.getGenerativeModel({
        model: GEMINI_CHAT_MODEL,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      });

      const geminiHistory = buildGeminiHistory(history);
      const chatSession = model.startChat({ history: geminiHistory });

      trace.logGeminiRequest(GEMINI_CHAT_MODEL, SYSTEM_PROMPT, fullMsg, contextNote);
      console.log('LLM request started (Gemini 2.5 Flash)');
      const result = await chatSession.sendMessage(fullMsg);
      const text = result.response.text().trim();
      console.log('LLM response received');

      const latency = Date.now() - tStart;
      trace.logGeminiResponse(GEMINI_CHAT_MODEL, text, latency, SYSTEM_PROMPT, fullMsg, contextNote);
      trace.logFunctionResult('llm.js', 'chat', text, latency);
      return text;
    } catch (geminiErr) {
      console.error('Gemini 2.5 Flash chat failed:', geminiErr.message);
      trace.logError('chat', { message }, geminiErr, 'Gemini 2.5 Flash primary');
      // fall through to static fallback
    }
  }

  // ── Static fallback ────────────────────────────────────────────────────
  const latency = Date.now() - tStart;
  const fallback = `I'm having a moment of trouble connecting to my AI backend. Your data is safe — please try again in a moment!`;
  trace.logFunctionResult('llm.js', 'chat', fallback, latency);
  return fallback;
}

// ─── Friendly error mapper ─────────────────────────────────────────────────
function friendlyLLMError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('429') || msg.includes('quota') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return `⚠️ I've hit my AI message limit for now.\n\nYour analytics still work! Try:\n• "Show my top products"\n• "What's my total revenue"\n• "Any low stock items"\n\nAI chat will be back shortly 🙏`;
  }
  if (msg.includes('api key') || msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('not configured') || msg.includes('invalid api key')) {
    return `⚠️ There's a setup issue with my AI connection. Please contact support.`;
  }
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('socket') || msg.includes('enotfound')) {
    return `⚠️ I couldn't reach the AI service right now. Please try again in a moment.`;
  }
  if (msg.includes('503') || msg.includes('502') || msg.includes('overloaded') || msg.includes('500')) {
    return `⚠️ The AI service is temporarily overloaded. Please try again in a few minutes.`;
  }
  return `⚠️ I'm having trouble responding right now. Please try again in a moment.`;
}

module.exports = { chat, buildHistory, SYSTEM_PROMPT, MODEL, client, keepAliveAgent, friendlyLLMError };
