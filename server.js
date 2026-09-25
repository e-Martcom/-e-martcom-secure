const express = require('express');
const app = express();
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
app.get('/api/test', (req, res) => {
  res.json({ ok: true });
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Live'));
