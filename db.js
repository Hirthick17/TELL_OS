// db.js — MongoDB database layer (production schema)
// Phase 3: Production data model with proper collections and indexes

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME   = 'shopbot';

let _client = null;
let _db     = null;

// ─── Connection (singleton) ───────────────────────────────────────────────
async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await _client.connect();
  _db = _client.db(DB_NAME);
  await createIndexes(_db);
  console.log('✅ MongoDB connected:', MONGO_URL.replace(/\/\/.*@/, '//***@'));
  return _db;
}

async function createIndexes(db) {
  // Data collections — always filter by session_id
  await db.collection('products').createIndex({ session_id: 1 });
  await db.collection('orders').createIndex({ session_id: 1 });
  await db.collection('inventory').createIndex({ session_id: 1 });
  await db.collection('payments').createIndex({ session_id: 1 });

  // Conversations — look up by sessionId or phoneNumber
  await db.collection('conversations').createIndex({ sessionId: 1 }, { unique: true });
  await db.collection('conversations').createIndex({ phoneNumber: 1 }, { sparse: true });

  // Legacy sessions collection
  await db.collection('sessions').createIndex({ id: 1 }, { unique: true });
}

// ─── Health check ─────────────────────────────────────────────────────────
async function isHealthy() {
  try {
    const db = await connect();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

// ─── Session management ───────────────────────────────────────────────────
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

// ─── Products ─────────────────────────────────────────────────────────────
async function insertProducts(sessionId, rows) {
  await ensureSession(sessionId);
  const db   = await connect();
  const docs = rows.map(r => ({
    session_id:   sessionId,
    product_id:   r.product_id   || r['Product ID']   || r.id   || '',
    name:         r.name         || r['Product Name']  || r.Name  || '',
    category:     r.category     || r.Category         || '',
    price:        parseFloat(r.price || r.Price || r['Unit Price'] || 0) || 0,
    sku:          r.sku          || r.SKU               || '',
    description:  r.description  || r.Description      || '',
    brand:        r.brand        || r.Brand             || '',
    unit:         r.unit         || r.Unit              || '',
    created_at:   new Date(),
  }));
  if (docs.length > 0) await db.collection('products').insertMany(docs);
}

// ─── Orders ───────────────────────────────────────────────────────────────
async function insertOrders(sessionId, rows) {
  await ensureSession(sessionId);
  const db   = await connect();
  const docs = rows.map(r => ({
    session_id:     sessionId,
    order_id:       r.order_id      || r['Order ID']      || r.id   || '',
    customer_name:  r.customer_name || r['Customer Name']  || r.customer || '',
    customer_email: r.customer_email|| r['Email']          || '',
    customer_phone: r.customer_phone|| r['Phone']          || '',
    product_name:   r.product_name  || r['Product']        || r['Item'] || '',
    quantity:       parseInt(r.quantity || r.Quantity || r.qty || 0) || 0,
    amount:         parseFloat(r.amount || r.Amount || r.total || r.Total || 0) || 0,
    status:         r.status        || r.Status             || '',
    order_date:     r.order_date    || r['Order Date']      || r.date || '',
    created_at:     new Date(),
  }));
  if (docs.length > 0) await db.collection('orders').insertMany(docs);
}

// ─── Inventory ────────────────────────────────────────────────────────────
async function insertInventory(sessionId, rows) {
  await ensureSession(sessionId);
  const db   = await connect();
  const docs = rows.map(r => ({
    session_id:     sessionId,
    product_name:   r.product_name  || r['Product Name']  || r.name || r.Name || '',
    sku:            r.sku           || r.SKU               || '',
    stock_quantity: parseInt(r.stock_quantity || r.stock || r.Stock || r.quantity || r.Quantity || 0) || 0,
    reorder_level:  parseInt(r.reorder_level  || r['Reorder Level'] || r.reorder || 0) || 0,
    warehouse:      r.warehouse     || r.Warehouse          || r.location || '',
    created_at:     new Date(),
  }));
  if (docs.length > 0) await db.collection('inventory').insertMany(docs);
}

// ─── Payments ─────────────────────────────────────────────────────────────
async function insertPayments(sessionId, rows) {
  await ensureSession(sessionId);
  const db   = await connect();
  const docs = rows.map(r => ({
    session_id:   sessionId,
    payment_id:   r.payment_id   || r['Payment ID']     || r.id   || '',
    order_id:     r.order_id     || r['Order ID']       || '',
    customer_name:r.customer_name|| r['Customer']       || r.customer || '',
    amount:       parseFloat(r.amount || r.Amount || r.total || 0) || 0,
    method:       r.method       || r['Payment Method'] || r.payment_method || '',
    status:       r.status       || r.Status             || '',
    payment_date: r.payment_date || r['Payment Date']   || r.date || '',
    created_at:   new Date(),
  }));
  if (docs.length > 0) await db.collection('payments').insertMany(docs);
}

// ─── Stats ────────────────────────────────────────────────────────────────
async function getStats(sessionId) {
  const db = await connect();
  const [products, orders, inventory, payments] = await Promise.all([
    db.collection('products').countDocuments({ session_id: sessionId }),
    db.collection('orders').countDocuments({ session_id: sessionId }),
    db.collection('inventory').countDocuments({ session_id: sessionId }),
    db.collection('payments').countDocuments({ session_id: sessionId }),
  ]);

  const revenueAgg = await db.collection('orders').aggregate([
    { $match:  { session_id: sessionId } },
    { $group:  { _id: null, total: { $sum: '$amount' } } },
  ]).toArray();

  return { products, orders, inventory, payments, revenue: revenueAgg[0]?.total || 0 };
}

// ─── Table data (for dashboard) ───────────────────────────────────────────
async function getTableData(sessionId) {
  const db = await connect();
  const proj = { projection: { _id: 0, created_at: 0, session_id: 0 } };
  const [products, orders, inventory, payments] = await Promise.all([
    db.collection('products').find({ session_id: sessionId }, proj).limit(200).toArray(),
    db.collection('orders').find({ session_id: sessionId }, proj).limit(200).toArray(),
    db.collection('inventory').find({ session_id: sessionId }, proj).limit(200).toArray(),
    db.collection('payments').find({ session_id: sessionId }, proj).limit(200).toArray(),
  ]);
  return { products, orders, inventory, payments };
}

module.exports = {
  connect, isHealthy,
  insertProducts, insertOrders, insertInventory, insertPayments,
  getStats, getTableData,
  confirmSession, ensureSession,
};
