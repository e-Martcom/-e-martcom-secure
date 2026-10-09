require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ===== SECURITY =====
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit M-Pesa - stop spam attacks
const mpesaLimiter = rateLimit({ windowMs: 15*60*1000, max: 30, message: { error: 'Too many M-Pesa requests, try later' } });
app.use('/api/stkpush', mpesaLimiter);
app.use('/api/mpesa/stk', mpesaLimiter);
app.use('/api/card-payment', mpesaLimiter);

// ===== FILES - PERSISTENT (survives Render restart) =====
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const SUPPLIERS_FILE = path.join(__dirname, 'suppliers.json');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: [] }, null, 2));
if (!fs.existsSync(SUPPLIERS_FILE)) fs.writeFileSync(SUPPLIERS_FILE, JSON.stringify({ suppliers: [], pendingProducts: [] }, null, 2));

function readOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return { orders: [] }; } }
function writeOrders(data) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2)); }
function readSuppliers() { try { return JSON.parse(fs.readFileSync(SUPPLIERS_FILE, 'utf8')); } catch { return { suppliers: [], pendingProducts: [] }; } }
function writeSuppliers(data) { fs.writeFileSync(SUPPLIERS_FILE, JSON.stringify(data, null, 2)); }

// ===== CONFIG - NO HARDCODED PASSWORDS =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) console.warn('⚠️ WARNING: ADMIN_PASSWORD not set in env!');
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox'; // set to 'live' in Render dashboard when ready

// PRODUCT DB - SERVER IS SOURCE OF TRUTH (fraud-proof)
// Add all your products here with real cost - frontend cannot cheat
const PRODUCT_DB = {
  1: { name: "Clover Bracelet 18K Gold", priceUSD: 1.87, weight: 0.05 },
  2: { name: "Samsung A71 Phone Case", priceUSD: 2.5, weight: 0.1 },
  3: { name: "Nike T-Shirt Sports Shorts", priceUSD: 5.2, weight: 0.2 },
  4: { name: "Oceanic Watch Luxury", priceUSD: 2.2, weight: 0.2 },
  5: { name: "iPhone 14 Pro Case", priceUSD: 2.0, weight: 0.15 },
};

// Shipping base cost in USD per pc
const BASE_COST = {
  china: { ke: 12, ug: 15, ng: 18, us: 20, ae: 16, gb: 20, de: 20 },
  kenya: { ke: 1.5, ug: 8, ng: 15, us: 18, ae: 15, gb: 18 },
  usa: { ke: 20, ug: 22, ng: 24, us: 2, ae: 16, gb: 14 },
  japan: { ke: 26, ug: 28, ng: 30, us: 22, ae: 18, gb: 16 },
  uk: { ke: 18, ug: 20, ng: 22, us: 14, ae: 12, gb: 2 },
};
const METHOD_M = { air: 1, sea: 0.35, eparcel: 0.65, rail: 0.55 };

// ===== HELPERS =====
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey || req.body.adminKey;
  if (!ADMIN_PASSWORD || key!== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized - wrong admin key' });
  next();
}
function normalizePhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('07')) p = '254' + p.slice(1);
  if (p.startsWith('7')) p = '254' + p;
  if (p.startsWith('0')) p = '254' + p.slice(1);
  return p;
}
function escLog(s) { return String(s || '').slice(0, 200); }

// FRAUD PROTECTION - server recalculates total from IDs only
function calculateServerTotal(items, origin, dest, method) {
  let subProd = 0, subShip = 0;
  (items || []).forEach(it => {
    const id = parseInt(it.id) || 1;
    const db = PRODUCT_DB[id] || { priceUSD: 1.87, weight: 0.2 };
    const qty = Math.max(1, Math.min(100, parseInt(it.qty) || 1));
    const o = (it.source || origin || 'china').toLowerCase();
    const d = (dest || 'ke').toLowerCase();
    const m = (method || 'eparcel').toLowerCase();
    const base = (BASE_COST[o] && BASE_COST[o][d]) || 20;
    const wMult = db.weight <= 0.5? 1 : db.weight <= 1? 1.5 : 2.2;
    const shipPerPc = base * wMult * (METHOD_M[m] || 0.65);
    subProd += db.priceUSD * qty;
    subShip += shipPerPc * qty;
  });
  const fee = subProd * 0.03;
  const totalUSD = subProd + subShip + fee;
  return { totalUSD: Math.round(totalUSD * 100) / 100, subProd, subShip, fee };
}

// ===== M-PESA DARAJA =====
async function getToken() {
  const isLive = MPESA_ENV === 'live';
  const url = isLive
   ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(url, { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}

async function stkPushLogic(phone, items, customerName, address, origin, dest, method) {
  const realPhone = normalizePhone(phone);
  if (!realPhone.startsWith('254') || realPhone.length < 12) throw new Error('Phone must be 2547... format');

  // SERVER CALCULATES PRICE - frontend price ignored
  const calc = calculateServerTotal(items, origin, dest, method);
  const finalAmountKES = Math.max(1, Math.round(calc.totalUSD * 130)); // USD->KES rate

  console.log(`STK Request: ${escLog(realPhone)} KES ${finalAmountKES} USD ${calc.totalUSD} dest ${dest} method ${method}`);

  const token = await getToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  if (!shortcode ||!passkey) throw new Error('MPESA_SHORTCODE or PASSKEY not set in env');

  let baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (baseUrl &&!baseUrl.startsWith('https://')) baseUrl = 'https://' + baseUrl.replace(/^https?:\/\//, '');
  if (!baseUrl) baseUrl = 'https://e-martcom-secure.onrender.com';
  const callbackUrl = `${baseUrl}/api/callback`;

  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const isLive = MPESA_ENV === 'live';
  const stkUrl = isLive
   ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
    : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

  const stkRes = await axios.post(stkUrl, {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: finalAmountKES,
    PartyA: realPhone,
    PartyB: shortcode,
    PhoneNumber: realPhone,
    CallBackURL: callbackUrl,
    AccountReference: 'E-MARTCOM',
    TransactionDesc: 'E-MARTCOM Order'
  }, { headers: { Authorization: `Bearer ${token}` } });

  const order = {
    id: Date.now(),
    CheckoutRequestID: stkRes.data.CheckoutRequestID,
    MerchantRequestID: stkRes.data.MerchantRequestID,
    phone: realPhone,
    customerName: escLog(customerName),
    amount: finalAmountKES,
    amountUSD: calc.totalUSD,
    calcBreakdown: calc,
    items: items,
    itemsText: (items || []).map(i => `ID${i.id}x${i.qty}`).join(', '),
    origin, dest, method,
    address: escLog(address),
    status: 'STK Sent',
    date: new Date().toISOString()
  };
  const data = readOrders();
  data.orders.unshift(order);
  writeOrders(data);
  return stkRes.data;
}

// ===== ROUTES =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/stkpush', async (req, res) => {
  try {
    const { phone, items, customerName, address, origin, dest, method } = req.body;
    const data = await stkPushLogic(phone, items, customerName, address, origin, dest, method);
    res.json(data);
  } catch (e) {
    console.error('STK Error:', e.response?.data || e.message);
    res.status(500).json(e.response?.data || { error: e.message });
  }
});

// Legacy route for old cart.html
app.post('/api/mpesa/stk', async (req, res) => {
  try {
    const { phone, items, customerName, address, origin, dest, method } = req.body;
    const data = await stkPushLogic(phone, items, customerName, address, origin, dest, method);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/card-payment', requireAdmin, async (req, res) => {
  try {
    // Card also recalculates server-side - no trust frontend
    const { items, customerName, phone, address, origin, dest, method } = req.body;
    const calc = calculateServerTotal(items, origin, dest, method);
    const finalAmountKES = Math.max(1, Math.round(calc.totalUSD * 130));
    const order = {
      id: Date.now(),
      CheckoutRequestID: 'CARD_' + Date.now(),
      phone: normalizePhone(phone),
      customerName: escLog(customerName),
      amount: finalAmountKES,
      amountUSD: calc.totalUSD,
      calcBreakdown: calc,
      items,
      itemsText: (items || []).map(i => `ID${i.id}x${i.qty}`).join(', '),
      address: escLog(address),
      origin, dest, method,
      status: 'PAID ✅ CARD',
      receipt: 'CARD' + Date.now(),
      date: new Date().toISOString()
    };
    const data = readOrders();
    data.orders.unshift(order);
    writeOrders(data);
    res.json({ success: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/callback', (req, res) => {
  console.log('CALLBACK:', JSON.stringify(req.body).slice(0, 800));
  try {
    const data = readOrders();
    const stk = req.body.Body?.stkCallback;
    if (stk) {
      const order = data.orders.find(o => o.CheckoutRequestID === stk.CheckoutRequestID);
      if (order) {
        if (stk.ResultCode === 0) {
          const meta = stk.CallbackMetadata?.Item || [];
          order.status = 'PAID ✅';
          order.receipt = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value || order.receipt;
          order.paidAt = new Date().toISOString();
        } else {
          order.status = `FAILED: ${stk.ResultDesc}`;
        }
        writeOrders(data);
      }
    }
  } catch (e) { console.error('Callback error', e); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/orders', requireAdmin, (req, res) => {
  res.json(readOrders());
});

app.get('/api/external-orders', requireAdmin, (req, res) => {
  // Sourcing logs - now protected
  const data = readOrders();
  res.json(data.orders.slice(0, 100));
});

app.post('/api/supplier/register', (req, res) => {
  const { supplier, product } = req.body;
  if (!supplier?.name ||!supplier?.phone ||!product?.name ||!product?.price) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const phone = normalizePhone(supplier.phone);
  if (!phone.startsWith('254')) return res.status(400).json({ error: 'Phone must be 2547...' });
  const sData = readSuppliers();
  sData.suppliers.push({...supplier, phone, id: Date.now(), date: new Date().toISOString() });
  sData.pendingProducts.push({
   ...product,
    price: parseFloat(product.price),
    retailPrice: Math.round(parseFloat(product.price) * 1.3),
    supplierPhone: phone,
    id: Date.now(),
    status: 'pending'
  });
  writeSuppliers(sData);
  res.json({ ok: true });
});

app.post('/api/dropship/fulfill', requireAdmin, (req, res) => {
  const { orderId } = req.body;
  const data = readOrders();
  const order = data.orders.find(o => String(o.CheckoutRequestID || o.CheckoutRequestID || o.id) === String(orderId) || String(o.CheckoutRequestID) === String(orderId) || String(o.id) === String(orderId));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const supplierPhone = process.env.SUPPLIER_PHONE || '254722000000';
  const msg = `*NEW ORDER - E-MARTCOM DIRECT*\n📦 ${order.itemsText}\n👤 SHIP TO:\nName: ${order.customerName}\nPhone: ${order.phone}\nAddress: ${order.address}\n\n⚠️ Ship DIRECT to customer, sender E-MARTCOM, no invoice.\nOrder: ${order.receipt || order.CheckoutRequestID}`;
  const link = `https://wa.me/${supplierPhone}?text=${encodeURIComponent(msg)}`;
  order.supplierNotified = true;
  writeOrders(data);
  res.json({ success: true, supplierLink: link });
});

app.post('/api/orders/clear', requireAdmin, (req, res) => {
  writeOrders({ orders: [] });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌊 E-MARTCOM V2 SECURE on ${PORT} ENV:${MPESA_ENV} ${ADMIN_PASSWORD? 'ADMIN SET' : 'NO ADMIN!'}`));
