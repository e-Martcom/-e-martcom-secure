const express = require('express');
const path = require('path');
const app = express();
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log('Live on ' + PORT));
// M-Pesa STK Push
app.post('/api/mpesa/stk', async (req, res) => {
  const { phone, amount } = req.body; // phone = 2547XXXXXXXX
  const token = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  
  // 1. Get Access Token
  const auth = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${token}` }
  }).then(r => r.json());

  // 2. STK Push
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0,-3);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

  const stk = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${auth.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: "https://e-martcom-secure.onrender.com/api/mpesa/callback",
      AccountReference: "E-MARTCOM",
      TransactionDesc: "E-MARTCOM Order"
    })
  }).then(r => r.json());

  res.json(stk);
});
