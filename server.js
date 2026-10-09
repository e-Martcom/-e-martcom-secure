const express=require('express');const cors=require('cors');const fs=require('fs');const path=require('path');const helmet=require('helmet');const rateLimit=require('express-rate-limit');const axios=require('axios');require('dotenv').config();
const app=express();const PORT=process.env.PORT||10000;
app.use(helmet({contentSecurityPolicy:false}));app.use(cors({origin:true}));app.use(express.json({limit:'100kb'}));
app.use(express.static(path.join(__dirname,'public')));
const limiter=rateLimit({windowMs:15*60*1000,max:200});const strict=rateLimit({windowMs:60*1000,max:10});
app.use('/api/',limiter);app.use('/api/stkpush',strict);
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'emart2024';const MPESA_ENV=process.env.MPESA_ENV||'sandbox';
const DATA_FILE=path.join(__dirname,'data','orders.json');
if(!fs.existsSync(path.join(__dirname,'data')))fs.mkdirSync(path.join(__dirname,'data'),{recursive:true});
const PRODUCT_DB={1:{priceUSD:1.87,weight:0.05,name:"Clover Bracelet"},2:{priceUSD:2.5,weight:0.1,name:"Samsung A71 Case"},3:{priceUSD:5.2,weight:0.2,name:"Nike Set"},4:{priceUSD:2.2,weight:0.2,name:"Oceanic Watch"},5:{priceUSD:2.0,weight:0.15,name:"iPhone Case"}};
const BASE={china:{ke:12,ug:15,ng:18,us:20},kenya:{ke:1.5,ug:8,ng:15,us:18},usa:{ke:20,ug:22,ng:24,us:2}};const MM={air:1,sea:0.35,eparcel:0.65,rail:0.55};
function readOrders(){try{if(!fs.existsSync(DATA_FILE))return{orders:[]};return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch{return{orders:[]};}}
function writeOrders(d){fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2));}
function calcSecure(items,origin,dest,method){let o=(origin||'china').toLowerCase();let d=(dest||'ke').toLowerCase();let m=(method||'eparcel').toLowerCase();if(!BASE[o])o='china';if(!BASE[o][d])d='ke';if(!MM[m])m='eparcel';let subProd=0,subShip=0;for(let it of items){let id=parseInt(it.id)||1;let qty=Math.max(1,Math.min(100,parseInt(it.qty)||1));let db=PRODUCT_DB[id]||{priceUSD:1.87,weight:0.2};let w=db.weight;let wm=w<=0.5?1:w<=1?1.5:2.2;let b=BASE[o][d];let ship=b*wm*MM[m];subProd+=db.priceUSD*qty;subShip+=ship*qty;}let fee=subProd*0.03;let totalUSD=subProd+subShip+fee;let totalKSh=Math.max(1,Math.floor(totalUSD*130));return{subProd,subShip,fee,totalUSD,totalKSh};}
function checkAdmin(req){let k=req.query.adminKey||req.body.adminKey||req.headers['x-admin-key']||'';return k&&k===ADMIN_PASSWORD;}

// ===== DARAJA REAL STK =====
async function getMpesaToken(){
  let url=MPESA_ENV==='live'?'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials':'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  let key=process.env.MPESA_CONSUMER_KEY; let secret=process.env.MPESA_CONSUMER_SECRET;
  if(!key||!secret) throw new Error("Missing MPESA_CONSUMER_KEY/SECRET in Render ENV");
  let auth=Buffer.from(key+':'+secret).toString('base64');
  let r=await axios.get(url,{headers:{Authorization:'Basic '+auth}});
  return r.data.access_token;
}
async function sendSTK(phone, amount){
  let token=await getMpesaToken();
  let shortcode=process.env.MPESA_SHORTCODE||'174379';
  let passkey=process.env.MPESA_PASSKEY;
  if(!passkey) throw new Error("Missing MPESA_PASSKEY");
  let timestamp=new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
  let password=Buffer.from(shortcode+passkey+timestamp).toString('base64');
  let baseUrl=process.env.BASE_URL||`https://e-martcom-secure.onrender.com`;
  let callback=baseUrl+'/api/mpesa/callback';
  let url=MPESA_ENV==='live'?'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest':'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
  let body={BusinessShortCode:shortcode,Password:password,Timestamp:timestamp,TransactionType:"CustomerPayBillOnline",Amount:Math.floor(amount),PartyA:phone,PartyB:shortcode,PhoneNumber:phone,CallBackURL:callback,AccountReference:"E-MARTCOM",TransactionDesc:"E-MARTCOM Order"};
  console.log("STK REQUEST",JSON.stringify(body));
  let r=await axios.post(url,body,{headers:{Authorization:'Bearer '+token}});
  return r.data;
}

app.get('/api/orders',(req,res)=>{if(!checkAdmin(req))return res.status(401).json({error:"Unauthorized"});res.json(readOrders());});
app.get('/api/external-orders',(req,res)=>{if(!checkAdmin(req))return res.status(401).json({error:"Unauthorized"});res.json(readOrders().orders||[]);});
app.get('/api/my-orders',(req,res)=>{let raw=String(req.query.phone||'').replace(/\D/g,'');if(!raw||raw.length<9)return res.status(400).json({error:"Phone required"});let phone=raw;if(phone.startsWith('0'))phone='254'+phone.slice(1);if(phone.startsWith('7'))phone='254'+phone;let data=readOrders();let my=(data.orders||[]).filter(o=>{if(o.isViewLog)return false;let op=String(o.phone||'').replace(/\D/g,'');return op&&(op===phone||op.endsWith(phone.slice(-9))||phone.endsWith(op.slice(-9)));}).map(o=>({date:o.date,amount:o.amount,status:o.status,itemsText:o.itemsText,address:o.address,receipt:o.receipt||o.CheckoutRequestID,CheckoutRequestID:o.CheckoutRequestID}));res.json({orders:my});});
app.post('/api/product-view',(req,res)=>{try{let {productId,productName,source}=req.body;if(!productId)return res.json({ok:true});let data=readOrders();data.orders.unshift({id:Date.now(),productId,productName:String(productName||'').slice(0,100),source:String(source||'alibaba').slice(0,30),time:new Date().toISOString(),date:new Date().toISOString(),amount:2000,customerPrice:2000,isViewLog:true});data.orders=data.orders.slice(0,200);writeOrders(data);res.json({ok:true});}catch{res.json({ok:true});}});

app.post('/api/stkpush',async(req,res)=>{
  try{
    let {phone,items,customerName,address,origin,dest,method}=req.body;
    if(!phone||!items||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Phone and items required"});
    let clean=String(phone).replace(/\D/g,'');if(clean.startsWith('0'))clean='254'+clean.slice(1);if(clean.startsWith('7'))clean='254'+clean;if(clean.length<12)return res.status(400).json({error:"Invalid phone format"});
    let sanitized=items.map(it=>({id:parseInt(it.id)||1,qty:Math.max(1,Math.min(100,parseInt(it.qty)||1)),source:String(it.source||origin||'china').toLowerCase().slice(0,10)}));
    let calc=calcSecure(sanitized,origin,dest,method);
    // SANDBOX MUST BE 1-150000? Daraja sandbox only allows KSh 1 for test paybill 174379
    // For live use calc.totalKSh directly
    let amountToCharge=MPESA_ENV==='live'?calc.totalKSh:1; // <- IMPORTANT: sandbox always 1
    console.log(`CUSTOMER STK ${clean} KSh ${amountToCharge} (real ${calc.totalKSh})`);
    let darajaRes=await sendSTK(clean,amountToCharge);
    if(darajaRes.ResponseCode!=='0') throw new Error(darajaRes.errorMessage||darajaRes.ResponseDescription||"STK failed");
    let data=readOrders();
    data.orders.unshift({id:Date.now(),CheckoutRequestID:darajaRes.CheckoutRequestID,MerchantRequestID:darajaRes.MerchantRequestID,receipt:darajaRes.CheckoutRequestID,phone:clean,customerName:String(customerName||'').slice(0,100),address:String(address||'').slice(0,300),amount:calc.totalKSh,realCharged:amountToCharge,itemsText:sanitized.map(i=>`${PRODUCT_DB[i.id]?.name||'Item'} x${i.qty}`).join(', '),items:sanitized,origin,dest,method,date:new Date().toISOString(),status:'STK_SENT_'+darajaRes.CheckoutRequestID,calc});
    writeOrders(data);
    res.json({success:true,CheckoutRequestID:darajaRes.CheckoutRequestID,CustomerMessage:darajaRes.CustomerMessage,amount:calc.totalKSh,charged:amountToCharge});
  }catch(e){
    console.error("STK ERROR",e.response?.data||e.message);
    res.status(500).json({error:"STK failed - check Render ENV keys",details:e.response?.data||e.message});
  }
});

app.post('/api/card-payment',(req,res)=>{if(!checkAdmin(req))return res.status(401).json({error:"Admin only"});try{let {items,customerName,phone,address,origin,dest,method}=req.body;let sanitized=items.map(it=>({id:parseInt(it.id)||1,qty:Math.max(1,Math.min(100,parseInt(it.qty)||1))}));let calc=calcSecure(sanitized,origin,dest,method);let clean=String(phone||'254700000000').replace(/\D/g,'');let CheckoutRequestID='CARD_'+Date.now();let data=readOrders();let order={id:Date.now(),CheckoutRequestID,receipt:'RCPT_'+Date.now(),phone:clean,customerName:String(customerName||'').slice(0,100),address:String(address||'').slice(0,300),amount:calc.totalKSh,itemsText:sanitized.map(i=>`${PRODUCT_DB[i.id]?.name||'Item'} x${i.qty}`).join(', '),items:sanitized,date:new Date().toISOString(),status:'PAID_CARD',calc};data.orders.unshift(order);writeOrders(data);res.json({success:true,order});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/mpesa/callback',(req,res)=>{try{console.log('CALLBACK',JSON.stringify(req.body).slice(0,1500));let stk=req.body.Body?.stkCallback;if(!stk)return res.json({ResultCode:0});let CheckoutRequestID=stk.CheckoutRequestID;let ResultCode=stk.ResultCode;let data=readOrders();let order=data.orders.find(o=>o.CheckoutRequestID===CheckoutRequestID);if(order){if(ResultCode===0){let meta=stk.CallbackMetadata?.Item||[];let receipt=meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value||'PAID';let amount=meta.find(i=>i.Name==='Amount')?.Value||order.amount;order.status='PAID_'+receipt;order.receipt=receipt;order.paidAmount=amount;order.paidAt=new Date().toISOString();}else{order.status='FAILED_'+ResultCode;order.failReason=stk.ResultDesc;}writeOrders(data);}res.json({ResultCode:0,ResultDesc:"Accepted"});}catch(e){console.error(e);res.json({ResultCode:0});}});
app.post('/api/dropship/fulfill',(req,res)=>{if(!checkAdmin(req))return res.status(401).json({error:"Unauthorized"});let {orderId}=req.body;let data=readOrders();let order=data.orders.find(o=>String(o.CheckoutRequestID||o.id)===String(orderId)||String(o.id)===String(orderId));if(!order)return res.status(404).json({error:"Not found"});order.supplierNotified=true;order.fulfilledAt=new Date().toISOString();writeOrders(data);let SUPPLIER_PHONE=process.env.SUPPLIER_PHONE||'254722000000';let msg=`*NEW ORDER - E-MARTCOM*%0A📦 ${encodeURIComponent(order.itemsText||'')}%0A👤 ${encodeURIComponent(order.customerName||'')} ${encodeURIComponent(order.phone||'')}%0A🏠 ${encodeURIComponent(order.address||'')}%0A🧾 ${encodeURIComponent(order.receipt||'')}`;res.json({success:true,supplierLink:`https://wa.me/${SUPPLIER_PHONE}?text=${msg}`});});
app.get('/api/health',(req,res)=>res.json({ok:true,env:MPESA_ENV,hasKeys:!!(process.env.MPESA_CONSUMER_KEY&&process.env.MPESA_PASSKEY)}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`✅ E-MARTCOM REAL STK on ${PORT} ENV ${MPESA_ENV}`));
