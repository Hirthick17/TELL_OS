// llm.js — Shared NVIDIA Llama 3.1 70B LLM setup, reused by server.js and meta-whatsapp.js
require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.NIM_KEY || '',
  baseURL: 'https://integrate.api.nvidia.com/v1',
});
const MODEL  = 'meta/llama-3.1-70b-instruct';

// ─── System prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are ShopBot, a friendly WhatsApp ecommerce assistant for small businesses and D2C sellers in India.

Your purpose:

Help users understand, analyze, and extract insights from Excel files.
Work with ANY spreadsheet structure.
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

Conversation Flow:

Before Upload:

Greet the user briefly.
Ask them to upload an Excel file (.xlsx or .csv).

After Upload:

Explain what was detected in the file.
Summarize sheets, columns, and key metrics.
Ask whether they would like insights, records, visualizations, or specific analysis.

Response Style:

Short and clear.
Business-friendly language.
Avoid technical jargon unless requested.
Focus on practical insights.
Use bullet points when useful.
Never be verbose.

Important Rules:

Schema is dynamic.
Dataset structure may change every upload.
Always adapt to the uploaded data.
Never assume ecommerce-specific columns.
Never invent data that is not present.`;

// ─── Build OpenAI history with system prompt as first exchange ────────────
// Converted to OpenAI format (role/content) compatible with NVIDIA NIM.
function buildHistory(userHistory = []) {
  // Transform from Gemini format (role/parts) to OpenAI format (role/content)
  const transformedHistory = userHistory.map(msg => {
    if (msg.parts) {
      return {
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: msg.parts.map(p => p.text).join('\n'),
      };
    }
    return msg;
  });

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...transformedHistory,
  ];
}

const trace = require('./trace');

// ─── Send a chat message via NVIDIA Llama 3.1 70B ──────────────────────────
// contextNote: optional string prepended to the user message (session state hints)
// history:     session.history array (Gemini role/parts format, converted to OpenAI)
// Returns: reply string
async function chat(message, history = [], contextNote = '') {
  const tStart = Date.now();
  trace.logFunctionEntered('llm.js', 'chat', { message, historyLength: history.length, contextNote }, 'server.js');
  
  if (!process.env.NIM_KEY ) {
    const err = new Error('NVIDIA_API_KEY not configured. Add it to .env and restart.');
    trace.logError('chat', { message, contextNote }, err, 'API key check');
    throw err;
  }

  try {
    const fullMsg    = contextNote ? `${contextNote} User: ${message}` : message;
    const messages   = buildHistory(history);
    messages.push({ role: 'user', content: fullMsg });
    
    trace.logGeminiRequest(MODEL, SYSTEM_PROMPT, fullMsg, contextNote);
    trace.logDataTransfer('chat', 'client.chat.completions.create', { historyLength: history.length });
    
    console.log("LLM request started");
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
    });
    console.log("LLM response received");
    
    const text = response.choices[0].message.content.trim();
    
    const latency = Date.now() - tStart;
    trace.logGeminiResponse(MODEL, text, latency, SYSTEM_PROMPT, fullMsg, contextNote);
    trace.logFunctionResult('llm.js', 'chat', text, latency);
    
    return text;
  } catch (err) {
    trace.logError('chat', { message, contextNote }, err, 'NVIDIA Llama sendMessage');
    throw err;
  }
}

module.exports = { chat, buildHistory, SYSTEM_PROMPT, MODEL, friendlyLLMError };

// ─── Friendly error mapper ────────────────────────────────────────────────
// Converts raw NVIDIA API errors into clean, user-facing WhatsApp messages.
// Always call this before displaying any LLM error to the user.
function friendlyLLMError(err) {
  const msg = (err?.message || '').toLowerCase();

  // Rate limit / daily quota exceeded (free tier limits)
  if (msg.includes('429') || msg.includes('quota') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return (
      `⚠️ I've hit my AI message limit for now.\n\n` +
      `But your analytics still work without AI! Try:\n` +
      `• "Show my top products"\n` +
      `• "What's my total revenue"\n` +
      `• "Any low stock items"\n` +
      `• "Any pending orders"\n\n` +
      `AI chat will be back shortly 🙏`
    );
  }

  // API key missing or invalid
  if (
    msg.includes('api key') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('not configured') ||
    msg.includes('invalid api key')
  ) {
    return `⚠️ There's a setup issue with my AI connection. Please contact support.`;
  }

  // Network / connection problems
  if (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('socket') ||
    msg.includes('enotfound')
  ) {
    return `⚠️ I couldn't reach the AI service right now. Please try again in a moment.`;
  }

  // Service unavailable / server error
  if (msg.includes('503') || msg.includes('502') || msg.includes('overloaded') || msg.includes('500')) {
    return `⚠️ The AI service is temporarily overloaded. Please try again in a few minutes.`;
  }

  // Generic fallback
  return `⚠️ I'm having trouble responding right now. Please try again in a moment.`;
}
