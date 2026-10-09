const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ========= SECURITY MIDDLEWARE =========
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limit - prevent spam
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: "Too many requests" } });
const strictLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: "Too fast" } });
app.use('/api/', limiter);
app.use('/api/stkpush', strictLimiter);
app.use('/api/card-payment', strictLimiter);

// Serve static
app.use(express.static(path.join(__dirname, 'public')));

// ========= CONFIG =========
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'emart2024';
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');

// Ensure data dir
if(!fs.existsSync(path.join(__dirname,'data'))) fs.mkdirSync(path.join(__dirname,'data'), {recursive:true});

// ========= PRODUCT DB - TRUTH (FRAUD-PROOF) =========
const PRODUCT_DB = {
  1: { priceUSD: 1.87, weight: 0.05, name: "Clover Bracelet" },
  2: { priceUSD: 2.5, weight: 0.1, name: "Samsung A71 Case" },
  3: { priceUSD: 5.2, weight: 0.2, name: "Nike Sports Set" },
  4: { priceUSD: 2.2, weight: 0.2, name: "Oceanic Watch" },
  5: { priceUSD: 2.0, weight: 0.15, name: "iPhone Case" },
};
const BASE = { china:{ke:12,ug:15,ng:18,us:20}, kenya:{ke:1.5,ug:8,ng:15,us:18}, usa:{ke:20,ug:22,ng:24,us:2} };
const MM = { air:1, sea:0.35, eparcel:0.65, rail:0.55 };

function readOrders(){
  try{
    if(!fs.existsSync(DATA_FILE)) return { orders: [] };
    let d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    if(!d.orders) d.orders=[];
    return d;
  }catch(e){ return { orders: [] }; }
}
function writeOrders(data){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }catch(e){ console.error(e); }
}
function calcSecure(items, origin, dest, method){
  let o=(origin||'china').toLowerCase();
  let d=(dest||'ke').toLowerCase();
  let m=(method||'eparcel').toLowerCase();
  if(!BASE[o]) o='china';
  if(!BASE[o][d]) d='ke';
  if(!MM[m]) m='eparcel';
  let subProd=0, subShip=0;
  for(let it of items){
    let id=parseInt(it.id)||1;
    let qty=Math.max(1, Math.min(100, parseInt(it.qty)||1));
    let db=PRODUCT_DB[id]||{priceUSD:1.87, weight:0.2};
    let w=db.weight;
    let wm=w<=0.5?1:w<=1?1.5:2.2;
    let b=BASE[o][d];
    let ship=b*wm*MM[m];
    subProd+=db.priceUSD*qty;
    subShip+=ship*qty;
  }
  let fee=subProd*0.03;
  let totalUSD=subProd+subShip+fee;
  let totalKSh=Math.floor(totalUSD*130);
  return { subProd, subShip, fee, totalUSD, totalKSh };
}
function checkAdmin(req){
  let key = req.query.adminKey || req.body.adminKey || req.headers['x-admin-key'] || '';
  return key && key === ADMIN_PASSWORD;
}

// ========= API - ORDERS =========
app.get('/api/orders', (req,res)=>{
  if(!checkAdmin(req)) return res.status(401).json({error:"Unauthorized - wrong ADMIN_PASSWORD"});
  let data=readOrders();
  res.json(data);
});

app.get('/api/external-orders', (req,res)=>{
  if(!checkAdmin(req)) return res.status(401).json({error:"Unauthorized"});
  let data=readOrders();
  res.json(data.orders||[]);
});

app.post('/api/orders/clear', (req,res)=>{
  if(!checkAdmin(req)) return res.status(401).json({error:"Unauthorized"});
  writeOrders({orders:[]});
  res.json({success:true});
});

// SECURE My Orders - phone filtered only
app.get('/api/my-orders', (req,res)=>{
  try{
    let raw=String(req.query.phone||'').replace(/\D/g,'');
    if(!raw || raw.length<9) return res.status(400).json({error:"Phone required"});
    let phone=raw;
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    if(phone.startsWith('7')) phone='254'+phone;
    let data=readOrders();
    let my=(data.orders||[]).filter(o=>{
      if(o.isViewLog) return false;
      let op=String(o.phone||'').replace(/\D/g,'');
      return op && (op===phone || op.endsWith(phone.slice(-9)) || phone.endsWith(op.slice(-9)));
    }).map(o=>({
      date:o.date, amount:o.amount, status:o.status, itemsText:o.itemsText,
      address:o.address, receipt:o.receipt||o.CheckoutRequestID, CheckoutRequestID:o.CheckoutRequestID
    }));
    res.json({orders:my});
  }catch(e){ res.status(500).json({error:"Server error"}); }
});

// Product view logger for sourcing dashboard
app.post('/api/product-view', (req,res)=>{
  try{
    let {productId, productName, source} = req.body;
    if(!productId) return res.json({ok:true});
    let data=readOrders();
    data.orders.unshift({
      id:Date.now(), productId, productName:String(productName||'').slice(0,100),
      source:String(source||'alibaba').slice(0,30), time:new Date().toISOString(),
      date:new Date().toISOString(), amount:2000, customerPrice:2000, isViewLog:true
    });
    data.orders=data.orders.slice(0,200);
    writeOrders(data);
    res.json({ok:true});
  }catch(e){ res.json({ok:true}); }
});

// ========= DROPSHIP FULFILL =========
app.post('/api/dropship/fulfill', (req,res)=>{
  if(!checkAdmin(req)) return res.status(401).json({error:"Unauthorized"});
  let {orderId} = req.body;
  if(!orderId) return res.status(400).json({error:"orderId required"});
  let data=readOrders();
  let order=data.orders.find(o=> String(o.CheckoutRequestID||o.id)===String(orderId) || String(o.id)===String(orderId));
  if(!order) return res.status(404).json({error:"Order not found"});
  order.supplierNotified=true;
  order.fulfilledAt=new Date().toISOString();
  writeOrders(data);
  let SUPPLIER_PHONE=process.env.SUPPLIER_PHONE||'254722000000';
  let msg=`*NEW ORDER - E-MARTCOM DIRECT DELIVERY*%0A%0A📦 *PRODUCTS:*%0A${encodeURIComponent(order.itemsText||'')}%0A%0A👤 *SHIP DIRECT TO:*%0A${encodeURIComponent(order.customerName||'')}%0A${encodeURIComponent(order.phone||'')}%0A${encodeURIComponent(order.address||'')}%0A%0A🧾 ${encodeURIComponent(order.receipt||order.CheckoutRequestID||'')}`;
  let link=`https://wa.me/${SUPPLIER_PHONE}?text=${msg}`;
  res.json({success:true, supplierLink:link});
});

// ========= PAYMENTS - FRAUD-PROOF =========
app.post('/api/stkpush', async (req,res)=>{
  try{
    let {phone, items, customerName, address, origin, dest, method} = req.body;
    if(!phone ||!items ||!Array.isArray(items) || items.length===0) return res.status(400).json({error:"phone and items required"});
    let clean=String(phone).replace(/\D/g,'');
    if(clean.startsWith('0')) clean='254'+clean.slice(1);
    if(clean.startsWith('7')) clean='254'+clean;
    if(clean.length<12) return res.status(400).json({error:"Invalid phone"});

    // FRAUD-PROOF: recalculate on server, ignore browser price
    let sanitized=items.map(it=>({id:parseInt(it.id)||1, qty:Math.max(1,Math.min(100,parseInt(it.qty)||1)), source:String(it.source||origin||'china').toLowerCase().slice(0,10)}));
    let calc=calcSecure(sanitized, origin, dest, method);

    // TODO: integrate real Daraja here
    // For sandbox we simulate
    let CheckoutRequestID='ws_CO_'+Date.now();
    let data=readOrders();
    data.orders.unshift({
      id:Date.now(), CheckoutRequestID, receipt:CheckoutRequestID,
      phone:clean, customerName:String(customerName||'').slice(0,100), address:String(address||'').slice(0,300),
      amount:calc.totalKSh, itemsText:sanitized.map(i=>`${PRODUCT_DB[i.id]?.name||'Item'} x${i.qty}`).join(', '),
      items:sanitized, origin, dest, method, date:new Date().toISOString(), status:'STK_SENT_'+calc.totalKSh,
      calc
    });
    writeOrders(data);

    console.log(`STK PUSH ${clean} KSh ${calc.totalKSh} ID ${CheckoutRequestID}`);
    // Simulate Daraja response
    res.json({ CheckoutRequestID, ResponseCode:"0", CustomerMessage:"Success. Request accepted for processing", amount:calc.totalKSh });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"STK failed", details:e.message});
  }
});

app.post('/api/card-payment', (req,res)=>{
  if(!checkAdmin(req)) return res.status(401).json({error:"Unauthorized - admin only card test"});
  try{
    let {items, customerName, phone, address, origin, dest, method} = req.body;
    if(!items ||!Array.isArray(items)) return res.status(400).json({error:"items required"});
    let sanitized=items.map(it=>({id:parseInt(it.id)||1, qty:Math.max(1,Math.min(100,parseInt(it.qty)||1))}));
    let calc=calcSecure(sanitized, origin, dest, method);
    let clean=String(phone||'254700000000').replace(/\D/g,'');
    let CheckoutRequestID='CARD_'+Date.now();
    let data=readOrders();
    let order={
      id:Date.now(), CheckoutRequestID, receipt:'RCPT_'+Date.now(),
      phone:clean, customerName:String(customerName||'').slice(0,100), address:String(address||'').slice(0,300),
      amount:calc.totalKSh, itemsText:sanitized.map(i=>`${PRODUCT_DB[i.id]?.name||'Item'} x${i.qty}`).join(', '),
      items:sanitized, date:new Date().toISOString(), status:'PAID_CARD', calc
    };
    data.orders.unshift(order);
    writeOrders(data);
    res.json({success:true, order});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// M-Pesa callback - Daraja will call this
app.post('/api/mpesa/callback', (req,res)=>{
  try{
    console.log('M-PESA CALLBACK', JSON.stringify(req.body).slice(0,1000));
    let body=req.body;
    let stk=body.Body?.stkCallback;
    if(!stk) return res.json({ResultCode:0, ResultDesc:"Accepted"});
    let CheckoutRequestID=stk.CheckoutRequestID;
    let ResultCode=stk.ResultCode;
    let data=readOrders();
    let order=data.orders.find(o=>o.CheckoutRequestID===CheckoutRequestID);
    if(order){
      if(ResultCode===0){
        let meta=stk.CallbackMetadata?.Item||[];
        let receipt=meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value||'PAID';
        let amount=meta.find(i=>i.Name==='Amount')?.Value||order.amount;
        order.status='PAID_'+receipt;
        order.receipt=receipt;
        order.paidAmount=amount;
        order.paidAt=new Date().toISOString();
      }else{
        order.status='FAILED_'+ResultCode;
      }
      writeOrders(data);
    }
    res.json({ResultCode:0, ResultDesc:"Accepted"});
  }catch(e){ console.error(e); res.json({ResultCode:0}); }
});

// ========= SUPPLIER =========
app.post('/api/supplier/register', (req,res)=>{
  try{
    let {name, phone, product} = req.body;
    if(!name ||!phone) return res.status(400).json({error:"name phone required"});
    console.log('SUPPLIER REGISTER', name, phone);
    res.json({success:true, message:"Supplier registered - we will contact"});
  }catch(e){ res.status(500).json({error:"Failed"}); }
});

// Health
app.get('/api/health', (req,res)=> res.json({ok:true, env:MPESA_ENV, time:new Date().toISOString()}));

// Fallback to index
app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, ()=> console.log(`✅ E-MARTCOM SECURE running on ${PORT} ENV ${MPESA_ENV}`));
