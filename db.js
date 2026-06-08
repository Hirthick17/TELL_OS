// db.js - MongoDB database layer (dataset-first schema)
// Reality is stored exactly as uploaded. Metadata and insights are generated
// alongside it, but never replace the raw rows.

const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME   = 'shopbot';

let _client = null;
let _db     = null;

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await _client.connect();
  _db = _client.db(DB_NAME);
  await createIndexes(_db);
  console.log('MongoDB connected:', MONGO_URL.replace(/\/\/.*@/, '//***@'));
  return _db;
}

async function createIndexes(db) {
  await db.collection('datasets').createIndex({ merchantId: 1, uploadedAt: -1 });
  await db.collection('datasets').createIndex({ merchantId: 1, status: 1, uploadedAt: -1 });

  await db.collection('dataset_records').createIndex({ merchantId: 1, datasetId: 1, rowNumber: 1 });
  await db.collection('dataset_records').createIndex({ datasetId: 1, sheetName: 1, rowNumber: 1 });

  await db.collection('dataset_metadata').createIndex({ datasetId: 1 }, { unique: true });
  await db.collection('dataset_metadata').createIndex({ merchantId: 1, 'detectedConcepts': 1 });

  await db.collection('dataset_insights').createIndex({ datasetId: 1 }, { unique: true });
  await db.collection('dataset_insights').createIndex({ merchantId: 1, updatedAt: -1 });

  await db.collection('conversations').createIndex({ sessionId: 1 }, { unique: true });
  await db.collection('conversations').createIndex({ phoneNumber: 1 }, { sparse: true });
  await db.collection('sessions').createIndex({ id: 1 }, { unique: true });

  await db.collection('missed_intents').createIndex({ 'session_snapshot.merchant_id': 1, resolved: 1, created_at: -1 });
  await db.collection('missed_intents').createIndex({ created_at: -1 });
}

async function isHealthy() {
  try {
    const db = await connect();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

async function ensureSession(sessionId) {
  const db = await connect();
  await db.collection('sessions').updateOne(
    { id: sessionId },
    { $setOnInsert: { id: sessionId, createdAt: new Date(), confirmed: false } },
    { upsert: true }
  );
}

async function confirmSession(sessionId) {
  const db = await connect();
  await db.collection('sessions').updateOne(
    { id: sessionId },
    { $set: { confirmed: true, confirmedAt: new Date() } }
  );
}

function newDatasetId() {
  return `dataset_${new ObjectId().toString()}`;
}

async function createDataset(merchantId, dataset) {
  await ensureSession(merchantId);
  const db = await connect();
  const now = new Date();
  const doc = {
    _id: dataset.datasetId || newDatasetId(),
    merchantId,
    fileName: dataset.fileName || 'Uploaded file',
    sheetNames: dataset.sheetNames || [],
    uploadedAt: dataset.uploadedAt || now,
    rowCount: dataset.rowCount || 0,
    columnCount: dataset.columnCount || 0,
    status: dataset.status || 'active',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('datasets').insertOne(doc);
  return doc;
}

async function updateDataset(datasetId, patch) {
  const db = await connect();
  await db.collection('datasets').updateOne(
    { _id: datasetId },
    { $set: { ...patch, updatedAt: new Date() } }
  );
}

async function insertDatasetRecordsBatch(merchantId, datasetId, sheetName, rows, startRowNumber = 1) {
  if (!rows || rows.length === 0) return;
  await ensureSession(merchantId);
  const db = await connect();
  const now = new Date();
  const docs = rows.map((row, idx) => ({
    merchantId,
    datasetId,
    sheetName,
    rowNumber: startRowNumber + idx,
    data: row,
    uploadedAt: now,
  }));
  await db.collection('dataset_records').insertMany(docs);
}

async function saveDatasetMetadata(merchantId, datasetId, metadata) {
  const db = await connect();
  await db.collection('dataset_metadata').updateOne(
    { datasetId },
    {
      $set: {
        ...metadata,
        merchantId,
        datasetId,
        generatedAt: metadata.generatedAt || new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function saveDatasetInsights(merchantId, datasetId, insights) {
  const db = await connect();
  await db.collection('dataset_insights').updateOne(
    { datasetId },
    {
      $set: {
        merchantId,
        datasetId,
        insights: insights.insights || insights || {},
        generatedAt: insights.generatedAt || new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function getDatasets(merchantId) {
  const db = await connect();
  const datasets = await db.collection('datasets')
    .find({ merchantId, status: { $ne: 'deleted' } })
    .sort({ uploadedAt: -1 })
    .toArray();

  if (datasets.length === 0) return [];
  const ids = datasets.map(d => d._id);
  const [metadata, insights] = await Promise.all([
    db.collection('dataset_metadata').find({ datasetId: { $in: ids } }, { projection: { _id: 0 } }).toArray(),
    db.collection('dataset_insights').find({ datasetId: { $in: ids } }, { projection: { _id: 0 } }).toArray(),
  ]);
  const metaById = new Map(metadata.map(m => [m.datasetId, m]));
  const insightsById = new Map(insights.map(i => [i.datasetId, i]));

  return datasets.map(d => ({
    ...d,
    metadata: metaById.get(d._id) || null,
    insights: insightsById.get(d._id)?.insights || {},
  }));
}

async function getDatasetBundle(merchantId, datasetId, limit = 1200) {
  const db = await connect();
  const [dataset, metadata, insights, records] = await Promise.all([
    db.collection('datasets').findOne({ _id: datasetId, merchantId }),
    db.collection('dataset_metadata').findOne({ datasetId, merchantId }, { projection: { _id: 0 } }),
    db.collection('dataset_insights').findOne({ datasetId, merchantId }, { projection: { _id: 0 } }),
    db.collection('dataset_records')
      .find({ datasetId, merchantId }, { projection: { _id: 0, merchantId: 0 } })
      .sort({ sheetName: 1, rowNumber: 1 })
      .limit(limit)
      .toArray(),
  ]);
  if (!dataset) return null;
  return {
    dataset,
    metadata,
    insights: insights?.insights || {},
    records,
  };
}

async function getStats(merchantId) {
  const datasets = await getDatasets(merchantId);
  if (datasets.length === 0) {
    return {
      datasets: 0,
      rows: 0,
      columns: 0,
      latestUpload: null,
    };
  }

  const datasetCount = datasets.length;
  const totalRows = datasets.reduce((sum, d) => sum + (d.rowCount || 0), 0);
  const totalColumns = datasets.reduce((sum, d) => sum + (d.columnCount || 0), 0);
  const latestDataset = datasets[0];

  // Return generic dataset metrics, not business assumptions
  return {
    datasets:     datasetCount,
    rows:         totalRows,
    columns:      totalColumns,
    latestUpload: latestDataset.uploadedAt || null,
    latestDatasetId: latestDataset._id,
    latestDatasetName: latestDataset.fileName,
  };
}

async function getTableData(merchantId) {
  const db = await connect();
  const datasets = await getDatasets(merchantId);
  if (datasets.length === 0) {
    return { sheets: [] };
  }

  // Build one tab per sheet from all datasets
  const result = { sheets: [] };

  for (const dataset of datasets) {
    const sheetNames = dataset.sheetNames || [];
    for (const sheetName of sheetNames) {
      const records = await db.collection('dataset_records')
        .find({ merchantId, datasetId: dataset._id, sheetName })
        .sort({ rowNumber: 1 })
        .limit(1000)
        .toArray();

      const rows = records.map(r => r.data);
      if (rows.length === 0) continue;

      result.sheets.push({
        name: sheetName,
        datasetId: dataset._id,
        datasetName: dataset.fileName,
        rows,
        rowCount: rows.length,
        columns: Object.keys(rows[0] || {}),
      });
    }
  }

  return result;
}

async function getUploadMetadata(merchantId) {
  const datasets = await getDatasets(merchantId);
  return {
    uploadedAt: datasets[0]?.uploadedAt || null,
    datasets: datasets.map(d => ({
      datasetId: d._id,
      fileName: d.fileName,
      sheetNames: d.sheetNames || [],
      rowCount: d.rowCount || 0,
      columnCount: d.columnCount || 0,
      columns: d.metadata?.columns || [],
      detectedConcepts: d.metadata?.detectedConcepts || [],
      insights: d.insights || {},
    })),
  };
}

async function buildLLMContext(merchantId) {
  const meta = await getUploadMetadata(merchantId);
  if (!meta.datasets || meta.datasets.length === 0) return null;

  const lines = ['Merchant datasets stored exactly as uploaded:'];
  for (const d of meta.datasets.slice(0, 6)) {
    lines.push(`- ${d.fileName} (${d.datasetId}): ${d.rowCount} rows, ${d.columnCount || d.columns.length} columns`);
    if (d.detectedConcepts?.length) lines.push(`  concepts: ${d.detectedConcepts.join(', ')}`);
    if (d.columns?.length) lines.push(`  columns: ${d.columns.slice(0, 14).join(', ')}${d.columns.length > 14 ? ', ...' : ''}`);
    const insightPairs = Object.entries(d.insights || {}).filter(([, v]) => v !== null && v !== undefined);
    if (insightPairs.length) {
      lines.push(`  insights: ${insightPairs.slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findMatchingColumn(columns, aliases) {
  const normalized = columns.map(c => ({ raw: c, norm: normalize(c) }));
  for (const alias of aliases) {
    const a = normalize(alias);
    const exact = normalized.find(c => c.norm === a);
    if (exact) return exact.raw;
  }
  for (const alias of aliases) {
    const a = normalize(alias);
    const contains = normalized.find(c => c.norm.includes(a) || a.includes(c.norm));
    if (contains) return contains.raw;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function getDataValue(record, column) {
  return record?.data?.[column];
}

// ─── NEW: Metadata-driven query execution engine ──────────────────────────────
// These functions execute queries dynamically based on detected metadata,
// never assuming fixed business domains. Every dataset is treated as its own entity.

/**
 * Execute a structured query plan on a dataset dynamically.
 * Query plans are generated by LLM and specify field, aggregation, filters, etc.
 * The execution is purely data-driven using detected metadata.
 */
async function executeQueryPlan(merchantId, datasetId, queryPlan) {
  const db = await connect();
  const dataset = await db.collection('datasets').findOne({ _id: datasetId, merchantId });
  if (!dataset) throw new Error('Dataset not found');

  const metadata = await db.collection('dataset_metadata').findOne({ datasetId });
  if (!metadata) throw new Error('Metadata not found for dataset');

  // Parse query plan: { operation, field, aggregation, filters, groupBy, limit }
  const { operation = 'aggregate', field, aggregation, filters = [], groupBy, limit = 100 } = queryPlan;

  if (operation === 'aggregate') {
    if (!field) throw new Error('Aggregate operation requires field');

    let matchStage = { merchantId, datasetId };
    for (const f of filters) {
      if (f.field && f.operator && f.value) {
        if (f.operator === 'eq') matchStage[`data.${f.field}`] = f.value;
        else if (f.operator === 'gt') matchStage[`data.${f.field}`] = { $gt: toNumber(f.value) };
        else if (f.operator === 'lt') matchStage[`data.${f.field}`] = { $lt: toNumber(f.value) };
      }
    }

    const pipeline = [{ $match: matchStage }];

    if (aggregation === 'sum' || aggregation === 'avg' || aggregation === 'count' || aggregation === 'min' || aggregation === 'max') {
      if (groupBy) {
        pipeline.push({
          $group: {
            _id: `$data.${groupBy}`,
            result: { [`$${aggregation}`]: aggregation === 'count' ? 1 : `$data.${field}` },
          },
        });
      } else {
        pipeline.push({
          $group: {
            _id: null,
            result: { [`$${aggregation}`]: aggregation === 'count' ? 1 : `$data.${field}` },
          },
        });
      }
      pipeline.push({ $limit: limit });
    }

    const results = await db.collection('dataset_records').aggregate(pipeline).toArray();
    return { field, aggregation, groupBy, results, datasetId, datasetName: dataset.fileName };
  }

  // Other operations (filter, sort, distinct, etc.)
  return null;
}

/**
 * Find which dataset best matches a user's query concepts
 */
async function findRelevantDatasetForQuery(merchantId, queryConcepts = []) {
  const datasets = await getDatasets(merchantId);
  if (datasets.length === 0) return null;

  let best = null;
  let bestScore = -1;
  const normalizedConcepts = queryConcepts.map(normalize);

  for (const d of datasets) {
    let score = 0;
    const datasetConcepts = (d.metadata?.detectedConcepts || []).map(normalize);
    for (const q of normalizedConcepts) {
      if (datasetConcepts.some(dc => dc.includes(q) || q.includes(dc))) score += 5;
    }
    // Bonus for datasets with metadata
    if (d.metadata?.columns?.length) score += 1;
    if (d.insights && Object.keys(d.insights).length) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best || datasets[0];
}

/**
 * Dynamically generate insights from actual dataset columns and data
 */
async function generateDatasetInsights(merchantId, datasetId) {
  const db = await connect();
  const [dataset, metadata] = await Promise.all([
    db.collection('datasets').findOne({ _id: datasetId, merchantId }),
    db.collection('dataset_metadata').findOne({ datasetId, merchantId }),
  ]);

  if (!dataset || !metadata) return {};

  const columns = metadata.columns || [];
  const insights = {};

  // Dynamically detect numeric columns for aggregation
  const numericCols = columns.filter(col => {
    const normalized = normalize(col).toLowerCase();
    return /\b(price|amount|revenue|quantity|qty|stock|count|total|value|rate|cost|sale)\b/.test(normalized);
  });

  // Dynamically detect identifier columns
  const idCols = columns.filter(col => {
    const normalized = normalize(col).toLowerCase();
    return /\b(id|name|title|item|product|customer|order|category|type)\b/.test(normalized);
  });

  // Generate basic statistics for each numeric column
  for (const col of numericCols.slice(0, 5)) {
    try {
      const pipeline = [
        { $match: { merchantId, datasetId } },
        {
          $group: {
            _id: null,
            sum: { $sum: `$data.${col}` },
            avg: { $avg: `$data.${col}` },
            min: { $min: `$data.${col}` },
            max: { $max: `$data.${col}` },
            count: { $sum: 1 },
          },
        },
      ];
      const result = await db.collection('dataset_records').aggregate(pipeline).toArray();
      if (result[0]) {
        insights[`${normalize(col)}_sum`] = result[0].sum;
        insights[`${normalize(col)}_avg`] = Math.round(result[0].avg * 100) / 100;
        insights[`${normalize(col)}_count`] = result[0].count;
      }
    } catch (e) {
      // Silently skip columns that fail aggregation
    }
  }

  // Count distinct values in identifier columns
  for (const col of idCols.slice(0, 3)) {
    try {
      const distinct = await db.collection('dataset_records').distinct(`data.${col}`, { merchantId, datasetId });
      insights[`unique_${normalize(col)}`] = distinct.filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
    } catch (e) {
      // Silently skip
    }
  }

  insights.lastUpdated = new Date();
  return insights;
}

// Compatibility aliases retained while server/router still imports old names.
// Deprecated: use prepareUploadSession + insertDatasetRecordsBatch directly
async function insertRawBatch() {
  throw new Error('insertRawBatch is deprecated. Use prepareUploadSession + insertDatasetRecordsBatch directly.');
}

// Create dataset document once at the start of an upload session
async function prepareUploadSession(merchantId, fileName, sheetPlans) {
  const totalRows = sheetPlans.reduce((sum, s) => sum + (s.rowCount || 0), 0);
  const allColumns = [...new Set(sheetPlans.flatMap(s => s.headers || []))];
  
  const dataset = await createDataset(merchantId, {
    fileName,
    sheetNames: sheetPlans.map(s => s.sheetName),
    rowCount:   totalRows,
    columnCount: allColumns.length,
  });
  
  return { datasetId: dataset._id, dataset };
}

async function saveUploadMetadata(sessionId, metadata) {
  const sheets = metadata.sheets || [];

  // Flatten all column headers across all sheets
  const allColumns = [...new Set(sheets.flatMap(s => s.columns || Object.keys(s.columnMap || {})))];

  // Flatten all detected concepts across all sheets
  const allConcepts = [...new Set(sheets.flatMap(s => s.detectedConcepts || []))];

  // Total column count from columnMap (semantic fields detected)
  const columnCount = Math.max(0, ...sheets.map(s => Object.keys(s.columnMap || {}).length));

  const dataset = await createDataset(sessionId, {
    fileName:    metadata.fileName || 'Uploaded file',
    sheetNames:  sheets.map(s => s.sheetName),
    rowCount:    sheets.reduce((sum, s) => sum + (s.rowCount || 0), 0),
    columnCount,
  });

  await saveDatasetMetadata(sessionId, dataset._id, {
    columns:          allColumns,
    rowCount:         dataset.rowCount,
    detectedConcepts: allConcepts,
    columnProfiles:   sheets.flatMap(s => s.columnProfiles || []),
    sheets,
  });

  // Pre-compute insights from column map so analytics queries work immediately
  const revenueSheet = sheets.find(s =>
    s.columnMap?.order_amount || s.columnMap?.price
  );
  const insights = {
    hasOrders:    sheets.some(s => s.columnMap?.order_id),
    hasProducts:  sheets.some(s => s.columnMap?.product_name),
    hasInventory: sheets.some(s => s.columnMap?.stock),
    hasPayments:  sheets.some(s => s.columnMap?.payment_method),
    totalRows:    dataset.rowCount,
    primarySheet: sheets[0]?.sheetName || null,
    revenueField: revenueSheet?.columnMap?.order_amount || revenueSheet?.columnMap?.price || null,
  };

  await saveDatasetInsights(sessionId, dataset._id, { insights });
}

module.exports = {
  connect,
  isHealthy,
  ensureSession,
  confirmSession,
  createDataset,
  updateDataset,
  insertDatasetRecordsBatch,
  saveDatasetMetadata,
  saveDatasetInsights,
  getDatasets,
  getDatasetBundle,
  getStats,
  getTableData,
  getUploadMetadata,
  buildLLMContext,
  findMatchingColumn,
  toNumber,
  findRelevantDatasetForQuery,
  executeQueryPlan,
  generateDatasetInsights,
  prepareUploadSession,
  insertRawBatch,
  saveUploadMetadata,
};
