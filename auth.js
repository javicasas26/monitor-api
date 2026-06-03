// src/index.js
// Punto de entrada de la API

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const routes  = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARES ──────────────────────────────────────────────
app.use(cors());                          // Permite requests desde el HTML (cualquier origen)
app.use(express.json({ limit: '10mb' })); // Parsear JSON — el límite cubre planillas grandes
app.use(express.urlencoded({ extended: true }));

// Log básico de cada request
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── RUTAS ────────────────────────────────────────────────────
app.use('/api', routes);

// Ruta raíz — útil para verificar que Railway desplegó correctamente
app.get('/', (req, res) => {
  res.json({
    name:    'Monitor de Cambios API',
    version: '1.0.0',
    status:  'running',
    docs:    '/api/health',
  });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Ruta ${req.path} no existe` });
});

// Manejo global de errores
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ ok: false, error: 'Error interno del servidor' });
});

// ── INICIAR ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ API corriendo en http://localhost:${PORT}`);
  console.log(`  Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Google API Key: ${process.env.GOOGLE_API_KEY ? 'configurada ✓' : 'NO configurada ✗'}`);
  console.log(`  API Secret: ${process.env.API_SECRET ? 'configurada ✓' : 'NO configurada ✗'}`);
});
