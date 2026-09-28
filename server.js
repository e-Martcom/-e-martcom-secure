const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const BASE_URL = process.env.BASE_URL || 'https://e-martcom-secure.onrender.com';

// --- OCEANIC ORDERS STORAGE ---
let ORDERS = [];
function saveOrders(){
  try{ fs.writeFileSync(path.join(__dirname,'orders.json'), JSON.stringify(ORDERS,null,2)); }catch(e){}
}
function loadOrders(){
  try{
    const file = path.join(__dirname,'orders.json');
    if(fs.existsSync(file)) ORDERS = JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(e){ ORDERS=[]; }
}
loadOrders();

async function getToken(){
  if(!CONSUMER_KEY) throw new Error('MPESA_CONSUMER_KEY missing in Render Environment');
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers:{Authorization:`Basic ${auth}`}
  });
  return r.data.access_token;
}

app.post('/api/mpesa/stk', async (req,res)=>{
  try{
    let {phone, amount, items} = req.body;
    console.log('--- NEW OCEANIC STK REQUEST ---');
    console.log('Phone:', phone, 'Amount:', amount);

    if(!phone) return res.status(400).json({success:false, error:'Phone required'});
    phone = phone.toString().replace(/[^0-9]/g,'');
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    if(phone.startsWith('7')) phone='254'+phone;
    
    amount = Math.round(Number(amount)||1);
    if(amount < 1) amount = 1;

    console.log('Formatted phone:', phone, 'Final amount:', amount);

    const token = await getToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    const password = Buffer.from(SHORTCODE+PASSKEY+timestamp).toString('base64');

    const payload={
      BusinessShortCode:SHORTCODE,
      Password:password,
      Timestamp:timestamp,
      TransactionType:"CustomerPayBillOnline",
      Amount: amount, // NOW USES REAL CART TOTAL!
      PartyA:phone,
      PartyB:SHORTCODE,
      PhoneNumber:phone,
      CallBackURL:`${BASE_URL}/api/mpesa/callback`,
      AccountReference:"E-MARTCOM",
      TransactionDesc:`Order KSh ${amount}`
    };

    console.log('Sending to Safaricom with amount', amount);
    const resp = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, {
      headers:{Authorization:`Bearer ${token}`}
    });
    console.log('SUCCESS:', resp.data);

    // SAVE ORDER FOR ADMIN
    if(resp.data.ResponseCode=="0"){
      const order = {
        id: Date.now(),
        phone, amount,
        items: items || [],
        CheckoutRequestID: resp.data.CheckoutRequestID,
        MerchantRequestID: resp.data.MerchantRequestID,
        status: "STK Sent - Awaiting PIN",
        date: new Date().toLocaleString('en-KE'),
        receipt: ""
      };
      ORDERS.unshift(order);
      saveOrders();
      console.log(`🌊 ORDER SAVED: KSh ${amount} - ${resp.data.CheckoutRequestID}`);
    }

    res.json({success:true, data:resp.data});
  }catch(e){
    console.log('=== SAFARICOM ERROR FULL ===');
    console.log('Status:', e.response?.status);
    console.log('Data:', JSON.stringify(e.response?.data,null,2));
    console.log('Message:', e.message);
    console.log('===========================');
    res.status(500).json({success:false, safaricom_error:e.response?.data, message:e.message});
  }
});

app.post('/api/mpesa/callback', (req,res)=>{
  console.log('🌊 CALLBACK RECEIVED:', JSON.stringify(req.body,null,2));
  try{
    const stkCallback = req.body.Body?.stkCallback;
    if(stkCallback){
      const checkoutId = stkCallback.CheckoutRequestID;
      const order = ORDERS.find(o=>o.CheckoutRequestID===checkoutId);
      if(order){
        if(stkCallback.ResultCode==0){
          const meta = stkCallback.CallbackMetadata?.Item || [];
          const receiptItem = meta.find(i=>i.Name=="MpesaReceiptNumber");
          order.status = "PAID ✅";
          order.receipt = receiptItem ? receiptItem.Value : "PAID";
          order.paidAt = new Date().toLocaleString('en-KE');
          console.log(`💰 PAID: ${checkoutId} - Receipt ${order.receipt} - KSh ${order.amount}`);
        } else {
          order.status = `FAILED: ${stkCallback.ResultDesc}`;
          console.log(`❌ FAILED: ${checkoutId} - ${stkCallback.ResultDesc}`);
        }
        saveOrders();
      }
    }
  }catch(e){ console.log("Callback error:", e.message); }
  res.json({ResultCode:0, ResultDesc:"Accepted - E-MARTCOM Oceanic"});
});

// ADMIN API
app.get('/api/orders', (req,res)=>{
  const totalSales = ORDERS.filter(o=>o.status.includes('PAID')).reduce((s,o)=>s+o.amount,0);
  res.json({orders: ORDERS, totalSales, count: ORDERS.length});
});
app.delete('/api/orders', (req,res)=>{
  ORDERS=[]; saveOrders(); res.json({ok:true, message:"Cleared"});
});

app.get('/', (req,res)=>{ res.sendFile(path.join(__dirname,'public','index.html')); });
app.get('/admin', (req,res)=>{ res.sendFile(path.join(__dirname,'public','admin.html')); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`🌊 E-MARTCOM OCEANIC LIVE on ${PORT} - Orders: ${ORDERS.length}`));
