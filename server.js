const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const ORDERS_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({orders: []}));

function saveOrder(order) {
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE));
  data.orders.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  const msg = `🌊 NEW ORDER! ${order.status}\n💰 KSh ${order.amount}\n📱 ${order.phone}\n🛒 ${order.itemsText || 'N/A'}\nID: ${order.CheckoutRequestID || order.id}`;
  console.log(`📲 WHATSAPP ALERT: ${msg}`);
  console.log(`👉 Click to send: https://wa.me/254713367205?text=${encodeURIComponent(msg)}`);
  return order;
}

async function getToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

async function stkPushLogic(phone, amount, items) {
  const token = await getToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const shortcode = process.env.MPESA_SHORTCODE || 174379;
  const passkey = process.env.MPESA_PASSKEY;
  
  // FIXED: Ensure callback is ALWAYS valid https URL
  let baseUrl = process.env.BASE_URL || "https://e-martcom-secure.onrender.com";
  baseUrl = baseUrl.replace(/\/$/, ''); // remove trailing slash
  if (!baseUrl.startsWith('https://')) {
    baseUrl = baseUrl.replace('http://', 'https://');
    if (!baseUrl.startsWith('https://')) baseUrl = 'https://' + baseUrl;
  }
  const callbackUrl = `${baseUrl}/api/callback`;
  
  console.log(`🔗 Using CallBackURL: ${callbackUrl}`);

  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: 'E-MARTCOM',
    TransactionDesc: 'Oceanic Store Payment'
  }, { headers: { Authorization: `Bearer ${token}` } });
  
  const order = {
    id: Date.now(),
    CheckoutRequestID: stkRes.data.CheckoutRequestID,
    MerchantRequestID: stkRes.data.MerchantRequestID,
    phone, amount, items,
    itemsText: items?.map(i=>`${i.name} x${i.qty}`).join(', '),
    status: 'STK Sent - Awaiting PIN',
    date: new Date().toISOString()
  };
  saveOrder(order);
  return stkRes.data;
}

app.post('/api/stkpush', async (req, res) => {
  try {
    const { phone, amount, items } = req.body;
    const data = await stkPushLogic(phone, amount, items);
    res.json(data);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json(e.response?.data || { error: e.message });
  }
});

app.post('/api/mpesa/stk', async (req, res) => {
  try {
    const { phone, amount, items } = req.body;
    const data = await stkPushLogic(phone, amount, items);
    res.json({ success: true, data, CheckoutRequestID: data.CheckoutRequestID });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json(e.response?.data || { error: e.message });
  }
});

app.post('/api/card-payment', (req, res) => {
  const { amount, items, cardLast4, customerName } = req.body;
  const order = {
    id: Date.now(),
    CheckoutRequestID: 'CARD_' + Date.now(),
    phone: customerName || 'CARD-' + (cardLast4 || '****'),
    amount, items,
    itemsText: items?.map(i=>`${i.name} x${i.qty}`).join(', '),
    status: 'PAID ✅ - VISA CARD',
    receipt: 'CARD_' + Math.random().toString(36).toUpperCase().slice(2,8),
    date: new Date().toISOString()
  };
  saveOrder(order);
  res.json({ success: true, order });
});

app.post('/api/callback', (req, res) => {
  console.log('CALLBACK:', JSON.stringify(req.body, null, 2));
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE));
    const stk = req.body.Body?.stkCallback;
    if (stk) {
      const order = data.orders.find(o => o.CheckoutRequestID === stk.CheckoutRequestID);
      if (order) {
        if (stk.ResultCode === 0) {
          const meta = stk.CallbackMetadata?.Item || [];
          order.status = 'PAID ✅ - M-PESA';
          order.receipt = meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value;
        } else {
          order.status = `FAILED: ${stk.ResultDesc}`;
        }
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
      }
    }
  } catch (e) { console.error(e); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/api/mpesa/callback', (req, res) => {
  console.log('CALLBACK MPESA:', JSON.stringify(req.body, null, 2));
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE));
    const stk = req.body.Body?.stkCallback;
    if (stk) {
      const order = data.orders.find(o => o.CheckoutRequestID === stk.CheckoutRequestID);
      if (order) {
        if (stk.ResultCode === 0) {
          const meta = stk.CallbackMetadata?.Item || [];
          order.status = 'PAID ✅ - M-PESA';
          order.receipt = meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value;
        } else {
          order.status = `FAILED: ${stk.ResultDesc}`;
        }
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
      }
    }
  } catch (e) { console.error(e); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/orders', (req, res) => {
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE));
  res.json(data);
});

app.get('/api/orders/clear', (req, res) => {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify({orders: []}));
  res.json({ cleared: true });
});

// External product link - hidden sourcing
app.post('/api/external-order', async (req,res)=>{
  const { productId, externalUrl, source } = req.body;
  // source = 'alibaba' | '1688' | 'jumia' | 'ebay' | 'madeinchina'
  console.log(`Sourcing ${productId} from ${source}: ${externalUrl}`);
  // Here you will later add automatic ordering via API
  // For now, we log it for you to order manually
  // You earn difference: Customer pays you KSh 23500, you buy at $150
  res.json({ok:true, msg:`Order will be sourced from ${source}`});
});
let suppliers = [];
let pendingProducts = [];

app.post('/api/supplier/register', (req,res)=>{
  const { supplier, product } = req.body;
  suppliers.push({...supplier, id:Date.now(), date:new Date()});
  if(product.name){
    pendingProducts.push({...product, id:Date.now(), supplier:supplier.name, status:'pending'});
  }
  console.log('NEW SUPPLIER:', supplier.name, supplier.phone);
  // Send you WhatsApp notification via your existing logic
  res.json({ok:true});
});

app.get('/api/supplier/pending', (req,res)=>{
  res.json({suppliers, pendingProducts});
});
let externalOrders = [];
app.post('/api/external-order', (req,res)=>{
  externalOrders.push(req.body);
  console.log('🌊 SECRET ORDER LOGGED:', req.body.productName, 'Profit:', Math.floor((req.body.customerPrice||0)*0.45));
  res.json({ok:true});
});

app.get('/api/external-orders', (req,res)=>{
  res.json(externalOrders);
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌊 Oceanic Server Live on ${PORT}`));
