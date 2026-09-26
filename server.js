const express = require('express');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

async function getToken(){
  if(!CONSUMER_KEY) throw new Error('MPESA_CONSUMER_KEY missing in Render Env');
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',{
    headers:{Authorization:`Basic ${auth}`}
  });
  return r.data.access_token;
}

app.post('/api/mpesa/stk', async (req,res)=>{
  try{
    let {phone, amount} = req.body;
    console.log('STK:',phone,amount);
    if(!phone) return res.status(400).json({error:'Phone required'});
    phone = phone.toString().replace(/[^0-9]/g,'');
    if(phone.startsWith('0')) phone='254'+phone.slice(1);
    if(phone.startsWith('7')) phone='254'+phone;
    amount = parseInt(amount)||1;

    const token = await getToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    const password = Buffer.from(SHORTCODE+PASSKEY+timestamp).toString('base64');

    const payload={
      BusinessShortCode:SHORTCODE,
      Password:password,
      Timestamp:timestamp,
      TransactionType:"CustomerPayBillOnline",
      Amount:amount,
      PartyA:phone,
      PartyB:SHORTCODE,
      PhoneNumber:phone,
      CallBackURL:"https://e-martcom-secure.onrender.com/api/mpesa/callback",
      AccountReference:"E-MARTCOM",
      TransactionDesc:"E-MARTCOM Payment"
    };

    const resp = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, {
      headers:{Authorization:`Bearer ${token}`}
    });
    console.log('Success:',resp.data);
    res.json(resp.data);
  }catch(e){
    console.error('MPESA FAIL:',e.response?.data||e.message);
    res.status(500).json({error:e.response?.data||e.message});
  }
});

app.post('/api/mpesa/callback',(req,res)=>{
  console.log('CALLBACK:',JSON.stringify(req.body,null,2));
  res.json({ResultCode:0,ResultDesc:'OK'});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||10000;
app.listen(PORT,'0.0.0.0',()=>console.log('E-MARTCOM LIVE on '+PORT));
