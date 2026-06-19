// intelligence.js — NVIDIA NIM Intelligence Layer + Gemini 2.5 Flash for Document Understanding
// - buildQueryPlan, generateDatasetInsights: Llama 3.1 70B via NVIDIA NIM
//   (Retained for high-accuracy structured JSON generation; column-name hallucination risk is high on smaller models)
// - inferDatasetSchema, extractTableFromImage: Gemini 2.5 Flash
//   (Runs only on file upload, at most once per session → stays within free quota of 20 req/day)

require('dotenv').config();
const https = require('https');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Gemini client (for schema inference & OCR only) ───────────────────────────────────
// Reserved for document upload events only — NOT intent classification.
// Free tier: ~20 requests/day → acceptable since uploads are rare.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const GEMINI_SCHEMA_MODEL = 'gemini-2.5-flash'; // Reserved for OCR + schema inference only



// ─── Persistent keep-alive HTTPS agent for all Axios NIM calls ───────────────────
// Reuses TCP/TLS connections to integrate.api.nvidia.com, saving ~150-200ms
// of handshake overhead on schema inference, query planning, and insight calls.
const nimKeepAliveAgent = new https.Agent({
  keepAlive:      true,
  maxSockets:     20,
  keepAliveMsecs: 60_000,
});

/**
 * Call NVIDIA NIM hosted API
 */
async function callNvidiaNIM(messages, systemPrompt = '') {
  const apiKey = process.env.NIM_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('NIM_KEY not configured in .env');
  }

  const model = 'meta/llama-3.1-70b-instruct';
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';

  const formattedMessages = [];
  if (systemPrompt) {
    formattedMessages.push({ role: 'system', content: systemPrompt });
  }
  formattedMessages.push(...messages);

  try {
    const response = await axios.post(
      url,
      {
        model: model,
        messages: formattedMessages,
        temperature: 0.1,
        max_tokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
        httpsAgent: nimKeepAliveAgent,   // reuse TCP connections
      }
    );
    return response.data?.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('NVIDIA NIM API Error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Step 1 & 2: Generate query plan from user prompt using MoE
 */
async function buildQueryPlan(question, datasetId, metadata) {
  const columns = metadata.columns || [];
  const schemaProfile = metadata.schemaProfile || {
    columns,
    dimensions: metadata.dimensions || [],
    measures: metadata.measures || [],
    columnTypes: {},
    semanticRoles: {},
    timeFields: [],
    entityFields: [],
    currencyFields: [],
    candidateRevenueFields: []
  };

  const systemPrompt = `You are a database query planner powered by a Mixture of Experts model.
Analyze the user's question and the Dataset Knowledge Graph to generate a structured MongoDB aggregation query plan.

Dataset Knowledge Graph:
${JSON.stringify(schemaProfile, null, 2)}

Return ONLY a valid JSON object matching this schema. Do not include markdown code block syntax (like \`\`\`json) or extra text:
{
  "operation": "aggregate",
  "field": "the column name to aggregate (MUST match one of the measures exactly, e.g., sales, quantity, price)",
  "aggregation": "sum | avg | count | min | max",
  "groupBy": "column name to group by (MUST match one of the entityFields or dimensions exactly), or null",
  "filters": [
    {
      "field": "column name to filter on",
      "operator": "eq | gt | lt",
      "value": "value to match"
    }
  ],
  "sort": {
    "field": "result | groupBy",
    "order": -1 | 1
  },
  "limit": 100
}

If the question is not a data query or does not map to a database query, return:
{
  "operation": "none",
  "field": null
}`;

  try {
    const raw = await callNvidiaNIM([{ role: 'user', content: `Question: "${question}"` }], systemPrompt);
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const plan = JSON.parse(clean);
    
    // Validate that the field and filters refer to existing columns
    if (plan.operation === 'aggregate' && plan.field) {
      const match = columns.find(c => c.toLowerCase() === plan.field.toLowerCase());
      if (match) plan.field = match; // ensure exact casing
      
      if (plan.groupBy) {
        const groupMatch = columns.find(c => c.toLowerCase() === plan.groupBy.toLowerCase());
        plan.groupBy = groupMatch || null;
      }
      
      if (Array.isArray(plan.filters)) {
        plan.filters = plan.filters.map(f => {
          const filterMatch = columns.find(c => c.toLowerCase() === f.field.toLowerCase());
          return filterMatch ? { ...f, field: filterMatch } : null;
        }).filter(Boolean);
      }
      return plan;
    }
    return { operation: 'none', field: null };
  } catch (err) {
    console.error('NIM query plan generation failed:', err.message);
    return { operation: 'none', field: null };
  }
}

/**
 * Generate 3-5 rich business insights at upload time using MoE
 */
async function generateDatasetInsights(fileName, columns, sampleRows) {
  const systemPrompt = `You are a business intelligence assistant powered by a Mixture of Experts model.
Analyze the file name, column names, and sample rows from an uploaded Excel file.
First, determine the overall context/topic of the file and write a short description (2-3 sentences) summarizing what this file is about and its business relevance.
Then, provide 3-5 key business insights, key performance indicators (KPIs), or growth suggestions based on the specific columns present.
Return the output as a clean JSON object with this schema:
{
  "description": "Short description of the file and its business context.",
  "insights": [
    "First business insight description...",
    "Second business insight description...",
    "Third business insight description..."
  ]
}
Return ONLY the JSON object. Do not include markdown code block syntax (like \`\`\`json) or extra text.`;

  const userContent = `File Name: "${fileName}"\nColumns: ${JSON.stringify(columns)}\nSample Records: ${JSON.stringify(sampleRows)}`;

  try {
    const raw = await callNvidiaNIM([{ role: 'user', content: userContent }], systemPrompt);
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (err) {
    console.error('NIM insights generation failed, using fallback:', err.message);
    return {
      description: `Excel dataset "${fileName}" containing columns: ${columns.slice(0, 5).join(', ')}.`,
      insights: [
        `Scanned dataset with columns: ${columns.slice(0, 4).join(', ')}.`,
        `Identified data fields related to: ${columns.filter(c => /price|amount|revenue|qty|stock/i.test(c)).slice(0, 3).join(', ') || 'general data'}.`,
        `Observability ready. Ask questions like "total revenue" or "top products" to analyze.`
      ]
    };
  }
}

/**
 * extractTableFromImage — powered by Gemini 2.5 Flash multimodal
 *
 * Consumes one Gemini request per image upload. Returns structured JSON
 * with tableName, columns, detectedConcepts, and rows.
 */
async function extractTableFromImage(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('GEMINI_API_KEY not configured in .env for image OCR');
  }

  console.log(`🖼️ [OCR] Sending image to Gemini 2.5 Flash for table extraction (${mimeType})...`);

  const model = genAI.getGenerativeModel({
    model: GEMINI_SCHEMA_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0,
      maxOutputTokens: 4096,
    },
  });

  const prompt = `You are a structured data extraction expert. Analyze the attached image containing a table, ledger, register, spreadsheet screenshot, invoice, or receipt.
Extract the columns and all rows of data.

Return your output as a valid JSON object matching this schema. Do not include markdown or extra text:
{
  "tableName": "A suitable name for this dataset (e.g. Sales Register, Inventory List, Products)",
  "columns": ["Col1", "Col2", ...],
  "detectedConcepts": ["products", "orders", "inventory", "payments", "sales"],
  "rows": [
    {
      "Col1": "Value1",
      "Col2": 12.34
    }
  ]
}

Ensure all extracted row values are mapped to the correct columns. Do not truncate rows.
Return ONLY the raw JSON object.`;

  const base64Image = imageBuffer.toString('base64');

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType, data: base64Image } },
    ]);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    const jsonStr   = (jsonStart >= 0 && jsonEnd > jsonStart) ? clean.slice(jsonStart, jsonEnd + 1) : clean;

    const parsed = JSON.parse(jsonStr);
    console.log(`✅ [OCR] Gemini extracted ${parsed.columns?.length || 0} columns, ${parsed.rows?.length || 0} rows.`);
    return parsed;
  } catch (err) {
    console.error('Gemini Vision table extraction failed:', err.message);
    throw err;
  }
}

/**
 * inferDatasetSchema — powered by Gemini 2.5 Flash (JSON mode)
 *
 * Analyzes filename, columns, and sample rows to categorize fields semantically.
 * Consumes one Gemini request per Excel/CSV upload.
 *
 * @param {string}   fileName   - The name of the file
 * @param {string[]} columns    - Array of detected column headers
 * @param {object[]} sampleRows - Sample rows from the dataset
 * @returns {Promise<object>}   - Dataset profile with schema mapping and confidence
 */
async function inferDatasetSchema(fileName, columns, sampleRows) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('GEMINI_API_KEY not configured in .env for schema inference');
  }

  console.log(`🧠 [SCHEMA] Sending to Gemini 2.5 Flash for schema inference: ${fileName}`);

  const model = genAI.getGenerativeModel({
    model: GEMINI_SCHEMA_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0,
      maxOutputTokens: 2048,
    },
  });

  const systemInstruction = `You are a database architect.
Analyze the file name, columns, and sample rows of a dataset to determine its schema profile.
Categorize all fields into dimensions and measures. Identify their type and semantic roles.

Return a JSON object matching this schema. Do not include markdown or extra text:
{
  "datasetType": "general name of the domain/type (e.g. hospital_records, payroll_data, sales_orders)",
  "confidence": 0.95,
  "description": "A 1-2 sentence description of what this dataset contains and represents.",
  "entities": ["list of primary entity concepts present, e.g. products, customers, orders"],
  "relationships": [
    {
      "from": "Entity Name (singular, e.g. Order)",
      "to": "Entity Name (singular, e.g. Customer)"
    }
  ],
  "schemaProfile": {
    "columns": ["list of all input columns exactly"],
    "columnTypes": {
      "Column1": "string | number | date | boolean"
    },
    "semanticRoles": {
      "Column1": "product_dimension | customer_dimension | time_dimension | quantity_metric | unit_price | revenue_metric | category_dimension | other"
    },
    "dimensions": ["list of dimension columns suitable for filtering/grouping. Must match input columns exactly."],
    "measures": ["list of numeric measure columns suitable for mathematical aggregation (sum, avg, min, max). Must match input columns exactly. Do NOT include IDs, zip codes, or dates."],
    "timeFields": ["list of date/time columns. Must match input columns exactly."],
    "entityFields": ["list of primary identifier or name columns (like Product, Customer, Store ID). Must match input columns exactly."],
    "currencyFields": ["list of price/currency columns. Must match input columns exactly."],
    "candidateRevenueFields": ["list of columns representing monetary totals, revenue, or amounts. Must match input columns exactly."]
  },
  "businessQuestions": [
    "3-5 specific questions a business user would ask that can be answered directly using these measures and dimensions."
  ]
}

Ensure every column in the input array appears in \"schemaProfile.columns\" and is classified in either \"schemaProfile.measures\" or \"schemaProfile.dimensions\".`;

  const userContent = `File: "${fileName}"\nColumns: ${JSON.stringify(columns)}\nSample Rows: ${JSON.stringify(sampleRows.slice(0, 3))}`;

  try {
    const result = await model.generateContent([
      { text: systemInstruction + '\n\n' + userContent },
    ]);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    const jsonStr   = (jsonStart >= 0 && jsonEnd > jsonStart) ? clean.slice(jsonStart, jsonEnd + 1) : clean;
    const profile   = JSON.parse(jsonStr);

    // --- Validation Checks ---
    if (!profile.relationships) profile.relationships = [];
    if (!profile.entities) profile.entities = [];
    if (typeof profile.confidence !== 'number') profile.confidence = 0.5;

    if (!profile.schemaProfile) profile.schemaProfile = {};
    const sp = profile.schemaProfile;
    if (!sp.columns) sp.columns = columns;
    if (!sp.columnTypes) sp.columnTypes = {};
    if (!sp.semanticRoles) sp.semanticRoles = {};
    if (!sp.dimensions) sp.dimensions = profile.dimensions || [];
    if (!sp.measures) sp.measures = profile.measures || [];
    if (!sp.timeFields) sp.timeFields = [];
    if (!sp.entityFields) sp.entityFields = [];
    if (!sp.currencyFields) sp.currencyFields = [];
    if (!sp.candidateRevenueFields) sp.candidateRevenueFields = [];

    // Ensure exact casing matches input columns and all lists are cleaned
    sp.measures = sp.measures.map(m => columns.find(col => col.toLowerCase() === m.toLowerCase()) || null).filter(Boolean);
    sp.dimensions = sp.dimensions.map(d => columns.find(col => col.toLowerCase() === d.toLowerCase()) || null).filter(Boolean);
    sp.timeFields = sp.timeFields.map(t => columns.find(col => col.toLowerCase() === t.toLowerCase()) || null).filter(Boolean);
    sp.entityFields = sp.entityFields.map(e => columns.find(col => col.toLowerCase() === e.toLowerCase()) || null).filter(Boolean);
    sp.currencyFields = sp.currencyFields.map(c => columns.find(col => col.toLowerCase() === c.toLowerCase()) || null).filter(Boolean);
    sp.candidateRevenueFields = sp.candidateRevenueFields.map(c => columns.find(col => col.toLowerCase() === c.toLowerCase()) || null).filter(Boolean);

    // Ensure every single input column is assigned to either measures or dimensions
    const assigned = new Set([...sp.measures, ...sp.dimensions]);
    for (const col of columns) {
      if (!assigned.has(col)) {
        const isId = /id|code|number|sku|roll|employee|phone|mobile|pin|zip|date|year/i.test(col);
        const isNum = sampleRows.slice(0, 3).some(r => {
          const val = r[col];
          return val !== '' && val !== null && !isNaN(Number(String(val).replace(/[\$,₹€£%]/g, '').replace(/,/g, '').trim()));
        });
        
        if (isNum && !isId) {
          sp.measures.push(col);
        } else {
          sp.dimensions.push(col);
        }
      }
    }

    // Backfill columnTypes and semanticRoles for any missing columns
    columns.forEach(col => {
      if (!sp.columnTypes[col]) {
        const isNum = sp.measures.includes(col);
        sp.columnTypes[col] = isNum ? 'number' : 'string';
      }
      if (!sp.semanticRoles[col]) {
        if (sp.timeFields.includes(col)) sp.semanticRoles[col] = 'time_dimension';
        else if (sp.currencyFields.includes(col)) sp.semanticRoles[col] = 'unit_price';
        else if (sp.measures.includes(col)) sp.semanticRoles[col] = 'quantity_metric';
        else if (/product|item/i.test(col)) sp.semanticRoles[col] = 'product_dimension';
        else if (/customer/i.test(col)) sp.semanticRoles[col] = 'customer_dimension';
        else sp.semanticRoles[col] = 'other';
      }
    });

    // Sync top-level measures/dimensions for backward compatibility
    profile.measures = sp.measures;
    profile.dimensions = sp.dimensions;

    return profile;

  } catch (err) {
    console.error('NIM schema inference failed, returning fallback:', err.message);
    
    const measures = [];
    const dimensions = [];
    const columnTypes = {};
    const semanticRoles = {};
    const timeFields = [];
    const entityFields = [];
    const currencyFields = [];
    const candidateRevenueFields = [];
    
    columns.forEach(col => {
      const isId = /id|code|number|sku|roll|employee|phone|mobile|pin|zip|date|year/i.test(col);
      const isNum = sampleRows.slice(0, 3).some(r => {
        const val = r[col];
        return val !== '' && val !== null && !isNaN(Number(String(val).replace(/[\$,₹€£%]/g, '').replace(/,/g, '').trim()));
      });
      
      if (isNum && !isId) {
        measures.push(col);
        columnTypes[col] = 'number';
        if (/price|amount|revenue|cost/i.test(col)) {
          semanticRoles[col] = 'revenue_metric';
          currencyFields.push(col);
          candidateRevenueFields.push(col);
        } else {
          semanticRoles[col] = 'quantity_metric';
        }
      } else {
        dimensions.push(col);
        columnTypes[col] = 'string';
        if (/date/i.test(col)) {
          semanticRoles[col] = 'time_dimension';
          timeFields.push(col);
        } else if (/product|item/i.test(col)) {
          semanticRoles[col] = 'product_dimension';
          entityFields.push(col);
        } else {
          semanticRoles[col] = 'other';
        }
      }
    });

    return {
      datasetType: 'generic_dataset',
      confidence: 0.5,
      description: `Dataset containing columns: ${columns.join(', ')}.`,
      entities: ['records'],
      relationships: [],
      measures,
      dimensions,
      schemaProfile: {
        columns,
        columnTypes,
        semanticRoles,
        dimensions,
        measures,
        timeFields,
        entityFields,
        currencyFields,
        candidateRevenueFields
      },
      businessQuestions: [`Total count of records`, `Filter by ${columns[0]}`]
    };
  }
}

/**
 * warmupGemini — send a lightweight ping to Gemini 2.5 Flash at server start.
 * Pre-resolves DNS and establishes the HTTPS connection, eliminating cold-start
 * delay on the first real upload request.
 */
async function warmupGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) return 'Gemini ⚠️ (no key)';
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_SCHEMA_MODEL });
    const result = await model.generateContent('Reply with one word: READY');
    const text = result.response.text().trim();
    return text ? `Gemini 2.5 Flash ✅` : 'Gemini ⚠️ (empty response)';
  } catch (e) {
    return `Gemini ❌ (${e.message})`;
  }
}

/**
 * extractTableFromDocument — Gemini 2.5 Flash multimodal for PDF files.
 * Uses the same output schema as extractTableFromImage so the upload pipeline is identical.
 */
async function extractTableFromDocument(buffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('GEMINI_API_KEY not configured for document parsing');
  }

  console.log(`📄 [DOC-PARSE] Sending ${mimeType} to Gemini 2.5 Flash...`);

  const model = genAI.getGenerativeModel({
    model: GEMINI_SCHEMA_MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.0, maxOutputTokens: 4096 },
  });

  const prompt = `You are a structured data extraction expert. Analyze this document and extract any tabular data you find.

Return your output as a valid JSON object matching this schema exactly:
{
  "tableName": "A suitable name for this dataset",
  "columns": ["Col1", "Col2", ...],
  "detectedConcepts": ["products", "orders", "inventory", "payments", "sales"],
  "rows": [{"Col1": "Value1", "Col2": 12.34}]
}

If there are multiple tables, extract the most data-rich one. If no tabular data exists, return:
{"tableName": "No Table Found", "columns": [], "detectedConcepts": [], "rows": []}

Return ONLY the raw JSON object. No markdown. No explanation.`;

  const base64Data = buffer.toString('base64');

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType, data: base64Data } },
    ]);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    const jsonStr   = (jsonStart >= 0 && jsonEnd > jsonStart) ? clean.slice(jsonStart, jsonEnd + 1) : clean;
    const parsed = JSON.parse(jsonStr);
    console.log(`✅ [DOC-PARSE] Extracted ${parsed.columns?.length || 0} columns, ${parsed.rows?.length || 0} rows.`);
    return parsed;
  } catch (err) {
    console.error('Document parse failed:', err.message);
    throw err;
  }
}

/**
 * extractTableFromText — extract tabular data from plain text content.
 */
async function extractTableFromText(textContent, fileName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('GEMINI_API_KEY not configured for text parsing');
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_SCHEMA_MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.0, maxOutputTokens: 4096 },
  });

  const prompt = `You are a structured data extraction expert. Analyze this text content from the file "${fileName}" and extract any tabular or structured data.

Return your output as a valid JSON object:
{
  "tableName": "A suitable name for this dataset",
  "columns": ["Col1", "Col2", ...],
  "detectedConcepts": ["products", "orders", "inventory", "payments", "sales"],
  "rows": [{"Col1": "Value1", "Col2": 12.34}]
}

If no tabular data exists, return:
{"tableName": "No Table Found", "columns": [], "detectedConcepts": [], "rows": []}

TEXT CONTENT:
${textContent.slice(0, 8000)}

Return ONLY the raw JSON object. No markdown. No explanation.`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    const jsonStr   = (jsonStart >= 0 && jsonEnd > jsonStart) ? clean.slice(jsonStart, jsonEnd + 1) : clean;
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('Text extraction failed:', err.message);
    throw err;
  }
}

module.exports = {
  callNvidiaNIM,
  buildQueryPlan,
  generateDatasetInsights,
  extractTableFromImage,
  extractTableFromDocument,
  extractTableFromText,
  inferDatasetSchema,
  warmupGemini,
};
