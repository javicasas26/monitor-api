require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const routes  = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({ name: 'Monitor de Cambios API', version: '1.0.0', status: 'running' });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Ruta ${req.path} no existe` });
});

app.listen(PORT, () => {
  console.log(`✓ API corriendo en puerto ${PORT}`);
  console.log(`  Google API Key: ${process.env.GOOGLE_API_KEY ? 'OK ✓' : 'FALTA ✗'}`);
  console.log(`  API Secret: ${process.env.API_SECRET ? 'OK ✓' : 'FALTA ✗'}`);
});
