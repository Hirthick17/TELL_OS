// intelligence.js — NVIDIA NIM Intelligence Layer
// Uses Mixture of Experts (MoE) model to identify intent, map queries, and generate insights.

require('dotenv').config();
const axios = require('axios');

/**
 * Call NVIDIA NIM hosted API
 */
async function callNvidiaNIM(messages, systemPrompt = '') {
  const apiKey = process.env.NIM_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('NIM_KEY not configured in .env');
  }

  const model = 'minimaxai/minimax-m2.7';
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
  const systemPrompt = `You are a database query planner using a Mixture of Experts model.
Analyze the user's question, the available columns, sheet structure, and concepts of the dataset, and return a JSON query plan to fetch the required data.

Available Columns in dataset: ${JSON.stringify(columns)}
Detected Concepts: ${JSON.stringify(metadata.detectedConcepts || [])}

Return ONLY a valid JSON object matching this schema. Do not include markdown code block syntax (like \`\`\`json) or extra text:
{
  "operation": "aggregate",
  "field": "the column name to aggregate (MUST match one of the Available Columns exactly)",
  "aggregation": "sum", "avg", "count", "min", or "max",
  "groupBy": "column name to group by, or null",
  "filters": [
    {
      "field": "column name to filter",
      "operator": "eq", "gt", or "lt",
      "value": "value to match"
    }
  ],
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

module.exports = {
  callNvidiaNIM,
  buildQueryPlan,
  generateDatasetInsights,
};
