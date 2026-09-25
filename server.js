const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.post('/api/order/create', (req,res) => res.json({orderId: 'EMC'+Date.now(), status: 'PENDING'}));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Live on ' + PORT));
