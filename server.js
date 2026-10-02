const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/product.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/cart.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cart.html')));
app.get('/product', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/cart', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cart.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const ORDERS_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({orders: []}));
const EXTERNAL_FILE = path.join(__dirname, 'external_orders.json');
if (!fs.existsSync(EXTERNAL_FILE)) fs.writeFileSync(EXTERNAL_FILE, JSON.stringify([]));

const MAIN_SUPPLIER_PHONE = process.env.SUPPLIER_PHONE || "254722000000";
const MAIN_SUPPLIER_NAME = "Kamukunji Supplier";

function saveOrder(order) {
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')||'{"orders":[]}');
  data.orders.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  return order;
}

// 🔒 FIXED - HIDES AMOUNT AND PROFIT FROM SUPPLIER
function notifySupplier(order){
  const customer = order.customerName||'Customer';
  const realPhone = order.actualPhone||order.phone||'';
  const supplierMsg = `*DROPSHIP ORDER - E-MARTCOM* \n\n📦 *PRODUCT TO BUY:*\n${order.itemsText}\n\n👤 *DELIVER TO:*\nName: ${customer}\nPhone: ${realPhone}\nAddress: ${order.address||'Nairobi'}\n\n🧾 Receipt: ${order.receipt||order.CheckoutRequestID}\n\n✅ Please confirm availability and delivery cost to Nanyuki.\nThank you!`;
  const waLink = `https://wa.me/${MAIN_SUPPLIER_PHONE}?text=${encodeURIComponent(supplierMsg)}`;
  console.log(`\n🏭 SUPPLIER NOTIFY (PRICE HIDDEN) -> ${MAIN_SUPPLIER_NAME} ${MAIN_SUPPLIER_PHONE}\n${waLink}\n`);
  return waLink;
}

function normalizePhone(phone){
  if(!phone) return '';
  if(String(phone).length < 7) return phone;
  let p = String(phone).replace(/\s+/g,'').replace(/^\+/,'');
  if(p.startsWith('07')) p = '254' + p.slice(1);
  if(p.startsWith('7')) p = '254' + p;
  if(p.startsWith('0')) p = '254' + p.slice(1);
  return p;
}
async function getToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}
async function stkPushLogic(phone, amount, items, customerName, address) {
  let realPhone = normalizePhone(phone);
  if(!realPhone.startsWith('254')) throw new Error('Phone must be 2547...');
  if(!amount || amount < 1) throw new Error('Amount must be >= KSh 1');
  const token = await getToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const shortcode = process.env.MPESA_SHORTCODE || 174379;
  const passkey = process.env.MPESA_PASSKEY;
  let baseUrl = (process.env.BASE_URL || "https://e-martcom-secure.onrender.com").replace(/\/$/, '');
  if (!baseUrl.startsWith('https://')) baseUrl = 'https://' + baseUrl.replace(/^https?:\/\//,'');
  const callbackUrl = `${baseUrl}/api/callback`;
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: shortcode, Password: password, Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline', Amount: amount,
    PartyA: realPhone, PartyB: shortcode, PhoneNumber: realPhone,
    CallBackURL: callbackUrl, AccountReference: 'E-MARTCOM', TransactionDesc: 'Oceanic Store Payment'
  }, { headers: { Authorization: `Bearer ${token}` } });
  const order = { id: Date.now(), CheckoutRequestID: stkRes.data.CheckoutRequestID, MerchantRequestID: stkRes.data.MerchantRequestID, phone: realPhone, actualPhone: realPhone, customerName: customerName||realPhone, amount, items, itemsText: items?.map(i=>`${i.name} x${i.qty}`).join(', '), address: address||'', status: 'STK Sent - Awaiting PIN', date: new Date().toISOString(), supplierNotified: false };
  saveOrder(order); return stkRes.data;
}
app.post('/api/stkpush', async (req, res) => {
  try { const { phone, amount, items, customerName, address } = req.body; const data = await stkPushLogic(phone, amount, items, customerName, address); res.json(data); }
  catch (e) { console.error(e.response?.data || e.message); res.status(500).json(e.response?.data || { error: e.message }); }
});
app.post('/api/mpesa/stk', async (req, res) => {
  try { const { phone, amount, items, customerName, address } = req.body; const data = await stkPushLogic(phone, amount, items, customerName, address); res.json({ success: true, data, CheckoutRequestID: data.CheckoutRequestID }); }
  catch (e) { console.error(e.response?.data || e.message); res.status(500).json(e.response?.data || { error: e.message }); }
});
app.post('/api/card-payment', (req, res) => {
  const { amount, items, customerName, phone, actualPhone, address } = req.body;
  let cust = customerName||'Customer';
  let realPhone = actualPhone||phone||'';
  if(realPhone &&!String(realPhone).startsWith('254')) realPhone = '254700000000';
  if(!realPhone) realPhone = '254700000000';
  const order = { id: Date.now(), CheckoutRequestID: 'CARD_' + Date.now(), phone: realPhone, actualPhone: realPhone, customerName: cust, amount, items, itemsText: items?.map(i=>`${i.name} x${i.qty}`).join(', '), address: address||'', status: 'PAID ✅ - VISA CARD', receipt: 'CARD_' + Math.random().toString(36).toUpperCase().slice(2,8), date: new Date().toISOString(), supplierNotified: false };
  saveOrder(order);
  const link = notifySupplier(order);
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8'));
  let idx = data.orders.findIndex(o=>o.CheckoutRequestID==order.CheckoutRequestID);
  if(idx>=0){ data.orders[idx].supplierNotified=true; data.orders[idx].fulfilledAt=new Date().toISOString(); }
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data,null,2));
  res.json({ success: true, order, supplierLink: link });
});
app.post('/api/callback', (req, res) => {
  console.log('CALLBACK:', JSON.stringify(req.body, null, 2));
  try { const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')); const stk = req.body.Body?.stkCallback; if (stk) { const order = data.orders.find(o => o.CheckoutRequestID === stk.CheckoutRequestID); if (order) { if (stk.ResultCode === 0) { const meta = stk.CallbackMetadata?.Item || []; order.status = 'PAID ✅ - M-PESA'; order.receipt = meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value; order.paidAt = new Date().toISOString(); notifySupplier(order); order.supplierNotified = true; } else { order.status = `FAILED: ${stk.ResultDesc}`; } fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2)); } } } catch (e) { console.error(e); } res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
app.post('/api/mpesa/callback', (req, res) => {
  try { const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')); const stk = req.body.Body?.stkCallback; if (stk) { const order = data.orders.find(o => o.CheckoutRequestID === stk.CheckoutRequestID); if (order) { if (stk.ResultCode === 0) { const meta = stk.CallbackMetadata?.Item || []; order.status = 'PAID ✅ - M-PESA'; order.receipt = meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value; order.paidAt = new Date().toISOString(); notifySupplier(order); order.supplierNotified = true; } else { order.status = `FAILED: ${stk.ResultDesc}`; } fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2)); } } } catch (e) { console.error(e); } res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
app.post('/api/dropship/fulfill', (req,res)=>{
  const { orderId } = req.body;
  const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8'));
  const order = data.orders.find(o=>o.id==orderId || o.CheckoutRequestID==orderId || o.CheckoutRequestID==orderId);
  if(!order) return res.status(404).json({error:'Order not found'});
  const link = notifySupplier(order);
  order.supplierNotified = true;
  order.fulfilledAt = new Date().toISOString();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  res.json({ok:true, supplierLink: link});
});
app.get('/api/orders', (req, res) => { const data = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')||'{"orders":[]}'); res.json(data); });
app.get('/api/orders/clear', (req, res) => { fs.writeFileSync(ORDERS_FILE, JSON.stringify({orders: []})); res.json({ cleared: true }); });
app.post('/api/external-order', (req,res)=>{ try{ let list = JSON.parse(fs.readFileSync(EXTERNAL_FILE,'utf8')||'[]'); const entry = {...req.body, time: new Date().toISOString(), sourcingLink: `https://www.google.com/search?q=${encodeURIComponent((req.body.productName||'')+' wholesale price 1688 Alibaba')}`}; list.unshift(entry); fs.writeFileSync(EXTERNAL_FILE, JSON.stringify(list, null, 2)); res.json({ok:true, count: list.length, sourcingLink: entry.sourcingLink}); }catch(e){ res.json({ok:true}); } });
app.get('/api/external-orders', (req,res)=>{ try{ const list = JSON.parse(fs.readFileSync(EXTERNAL_FILE,'utf8')||'[]'); res.json(list); }catch(e){ res.json([]); } });
let suppliers = []; let pendingProducts = [];
app.post('/api/supplier/register', (req,res)=>{ const { supplier, product } = req.body; suppliers.push({...supplier, id:Date.now(), date:new Date()}); if(product && product.name){ pendingProducts.push({...product, id:Date.now(), supplier:supplier.name, status:'pending'}); } res.json({ok:true}); });
app.get('/api/supplier/pending', (req,res)=>{ res.json({suppliers, pendingProducts}); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌊 Oceanic Live on ${PORT} - PRICE HIDDEN FROM SUPPLIER`));
