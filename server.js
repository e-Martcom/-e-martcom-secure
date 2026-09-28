const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const ORDERS_FILE = './orders.json';
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
  const password = Buffer.from(`174379${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: 174379,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: 174379,
    PhoneNumber: phone,
    CallBackURL: `${process.env.BASE_URL}/api/callback`,
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

app.get('/api/orders', (req, res) => {
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE));
  res.json(data);
});

app.get('/api/orders/clear', (req, res) => {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify({orders: []}));
  res.json({ cleared: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌊 Oceanic Server Live on ${PORT}`));
