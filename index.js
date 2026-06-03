require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── DB ──────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'monitor.db');
let _db = null;
async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  _db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  _db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT, sheet_url TEXT, sheet_name TEXT,
      saved_at TEXT, saved_by TEXT, row_count INTEGER, data TEXT
    );
    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT, sheet_url TEXT, detected_at TEXT, detected_by TEXT,
      sku TEXT, change_type TEXT, row_num INTEGER, solicitud TEXT,
      diffs TEXT, accepted_at TEXT, accepted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_client  ON change_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_snap_client ON snapshots(client_id);
  `);
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  return _db;
}
function persist() {
  if (!_db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(_db.export())); } catch(e) { console.error('DB error:', e.message); }
}
function sp(sql, p) {
  if (!p || !p.length) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = p[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}
function r2o(cols, vals) { const o = {}; cols.forEach((c, i) => { o[c] = vals[i]; }); return o; }
async function dbRun(sql, p=[]) { const db = await getDb(); db.run(sp(sql, p)); persist(); }
async function dbGet(sql, p=[]) {
  const db = await getDb(); const r = db.exec(sp(sql, p));
  if (!r.length || !r[0].values.length) return undefined;
  return r2o(r[0].columns, r[0].values[0]);
}
async function dbAll(sql, p=[]) {
  const db = await getDb(); const r = db.exec(sp(sql, p));
  if (!r.length) return [];
  return r[0].values.map(v => r2o(r[0].columns, v));
}

// ── AUTH ────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET)
    return res.status(401).json({ ok: false, error: 'API secret inválido' });
  const u = (req.headers['x-user'] || '').trim();
  if (!u) return res.status(400).json({ ok: false, error: 'x-user requerido' });
  req.user = u; next();
}

// ── SHEETS ──────────────────────────────────────────────────
function cid(url) {
  let h = 0;
  for (const c of String(url)) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return 'cl_' + Math.abs(h).toString(36);
}

async function readSheet({ sheetUrl, sheetName, headerRow, skuKeyword, solKeyword }) {
  const sid = String(sheetUrl).match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!sid) throw new Error('URL inválida');
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(sheetName + '!A1:Z5000')}?key=${process.env.GOOGLE_API_KEY}`
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);

  const vals = d.values || [], hi = (headerRow || 2) - 1;
  const headers = (vals[hi] || []).map(c => String(c || '').trim());
  let si = -1, li = -1;
  headers.forEach((h, i) => {
    const v = h.toLowerCase();
    if (si < 0 && v.includes((skuKeyword || 'Sku').toLowerCase())) si = i;
    if (li < 0 && v.includes((solKeyword || 'Solicitud').toLowerCase())) li = i;
  });

  // Ancho máximo de fila en la hoja (para detectar celdas vaciadas)
  const maxCols = headers.length;

  const rows = vals.slice(hi + 1).map((row, i) => {
    const sku = si >= 0 ? String(row[si] || '').trim() : '';
    const sol = li >= 0 ? String(row[li] || '').trim() : '';
    const cells = {};
    // IMPORTANTE: iterar todos los headers, no solo los que tienen valor en la fila
    // Esto detecta celdas que fueron vaciadas (antes tenían valor, ahora están vacías)
    headers.forEach((name, ci) => {
      if (name) cells[name] = String(row[ci] || '').trim();
    });
    return { rowNum: hi + 2 + i, sku, solicitud: sol, cells };
  }).filter(r => r.sku || r.solicitud);

  return { headerNames: headers, skuColIdx: si, solColIdx: li, rows };
}

// ── DIFF ENGINE ─────────────────────────────────────────────
function computeDiff(currentRows, snapshotRows, solColName) {
  const snapMap = {}, currMap = {};
  (snapshotRows || []).forEach(r => { if (r.sku) snapMap[r.sku] = r; });
  currentRows.forEach(r => { if (r.sku) currMap[r.sku] = r; });

  const allSkus = new Set([...Object.keys(snapMap), ...Object.keys(currMap)]);
  const changes = [];

  allSkus.forEach(sku => {
    const prev = snapMap[sku], curr = currMap[sku];

    if (!prev && curr) {
      changes.push({ sku, rowNum: curr.rowNum, changeType: 'new', solicitud: curr.solicitud, diffs: [] });
      return;
    }
    if (prev && !curr) {
      changes.push({ sku, rowNum: prev.rowNum, changeType: 'deleted', solicitud: '', diffs: [] });
      return;
    }

    const diffs = [];
    // Unión de columnas de ambas versiones — detecta columnas vaciadas
    const allCols = new Set([...Object.keys(prev.cells || {}), ...Object.keys(curr.cells || {})]);
    allCols.forEach(col => {
      const vPrev = String(prev.cells?.[col] || '').trim();
      const vCurr = String(curr.cells?.[col] || '').trim();
      // Detecta cambio aunque uno sea vacío (celda vaciada O celda rellenada)
      if (vPrev !== vCurr) diffs.push({ col, before: vPrev, after: vCurr });
    });

    if (!diffs.length) return;

    const hasSol  = diffs.some(d => d.col === solColName);
    const hasOth  = diffs.some(d => d.col !== solColName);
    const changeType = hasSol && !hasOth ? 'solicitud' : 'modified';
    changes.push({ sku, rowNum: curr.rowNum, changeType, solicitud: curr.solicitud, diffs });
  });

  return changes;
}

// ── ROUTES ──────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ name: 'Monitor API', status: 'running' }));

app.get('/api/health', (req, res) =>
  res.json({ ok: true, message: 'Monitor de Cambios API corriendo', ts: new Date().toISOString() })
);

// POST /api/load
app.post('/api/load', auth, async (req, res) => {
  const { sheetUrl, sheetName = 'Hoja 1', headerRow = 2, skuKeyword = 'Sku', solKeyword = 'Solicitud' } = req.body;
  if (!sheetUrl) return res.status(400).json({ ok: false, error: 'sheetUrl requerido' });
  try {
    const { headerNames, skuColIdx, solColIdx, rows } = await readSheet({ sheetUrl, sheetName, headerRow, skuKeyword, solKeyword });
    const id = cid(sheetUrl);
    const solColName = solColIdx >= 0 ? headerNames[solColIdx] : null;
    const snap = await dbGet('SELECT * FROM snapshots WHERE client_id = ? ORDER BY id DESC LIMIT 1', [id]);

    let changes = [];
    if (snap) {
      changes = computeDiff(rows, JSON.parse(snap.data), solColName);
      const now = new Date().toISOString();
      const db = await getDb();
      for (const ch of changes) {
        const exists = db.exec(sp(
          'SELECT id FROM change_log WHERE client_id = ? AND sku = ? AND change_type = ? AND accepted_at IS NULL',
          [id, ch.sku, ch.changeType]
        ));
        if (!exists.length || !exists[0].values.length) {
          await dbRun(
            'INSERT INTO change_log (client_id,sheet_url,detected_at,detected_by,sku,change_type,row_num,solicitud,diffs) VALUES (?,?,?,?,?,?,?,?,?)',
            [id, sheetUrl, now, req.user, ch.sku, ch.changeType, ch.rowNum, ch.solicitud || '', JSON.stringify(ch.diffs || [])]
          );
        }
      }
    }

    res.json({
      ok: true, clientId: id, isFirstLoad: !snap,
      loadedBy: req.user, loadedAt: new Date().toISOString(),
      totalRows: rows.length,
      snapshot: snap ? { savedAt: snap.saved_at, savedBy: snap.saved_by } : null,
      summary: {
        new:       changes.filter(c => c.changeType === 'new').length,
        deleted:   changes.filter(c => c.changeType === 'deleted').length,
        modified:  changes.filter(c => c.changeType === 'modified').length,
        solicitud: changes.filter(c => c.changeType === 'solicitud').length,
      },
      changes, rows, headerNames,
    });
  } catch (e) { console.error('[/load]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/snapshot
app.post('/api/snapshot', auth, async (req, res) => {
  const { sheetUrl, sheetName = 'Hoja 1', rows } = req.body;
  if (!sheetUrl || !Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'sheetUrl y rows requeridos' });
  const now = new Date().toISOString();
  await dbRun(
    'INSERT INTO snapshots (client_id,sheet_url,sheet_name,saved_at,saved_by,row_count,data) VALUES (?,?,?,?,?,?,?)',
    [cid(sheetUrl), sheetUrl, sheetName, now, req.user, rows.length, JSON.stringify(rows)]
  );
  res.json({ ok: true, savedAt: now, savedBy: req.user });
});

// POST /api/accept
app.post('/api/accept', auth, async (req, res) => {
  const { sheetUrl, sheetName = 'Hoja 1', rows } = req.body;
  if (!sheetUrl || !Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'sheetUrl y rows requeridos' });
  const id = cid(sheetUrl), now = new Date().toISOString();
  const count = await dbGet('SELECT COUNT(*) as n FROM change_log WHERE client_id = ? AND accepted_at IS NULL', [id]);
  await dbRun('UPDATE change_log SET accepted_at=?,accepted_by=? WHERE client_id=? AND accepted_at IS NULL', [now, req.user, id]);
  await dbRun(
    'INSERT INTO snapshots (client_id,sheet_url,sheet_name,saved_at,saved_by,row_count,data) VALUES (?,?,?,?,?,?,?)',
    [id, sheetUrl, sheetName, now, req.user, rows.length, JSON.stringify(rows)]
  );
  res.json({ ok: true, acceptedChanges: count?.n || 0, savedAt: now, savedBy: req.user });
});

// GET /api/log/:clientId
app.get('/api/log/:clientId', auth, async (req, res) => {
  const { limit = 200, offset = 0, changeType, sku, pending } = req.query;
  let w = 'WHERE client_id = ?'; const a = [req.params.clientId];
  if (changeType) { w += ' AND change_type = ?'; a.push(changeType); }
  if (sku)        { w += ' AND sku LIKE ?';       a.push(`%${sku}%`); }
  if (pending === 'true')  w += ' AND accepted_at IS NULL';
  if (pending === 'false') w += ' AND accepted_at IS NOT NULL';
  const rows  = await dbAll(`SELECT * FROM change_log ${w} ORDER BY detected_at DESC LIMIT ? OFFSET ?`, [...a, parseInt(limit), parseInt(offset)]);
  const total = await dbGet(`SELECT COUNT(*) as n FROM change_log ${w}`, a);
  res.json({ ok: true, total: total?.n || 0, rows: rows.map(r => ({ ...r, diffs: JSON.parse(r.diffs || '[]') })) });
});

// GET /api/log/:clientId/summary
app.get('/api/log/:clientId/summary', auth, async (req, res) => {
  const counts = await dbAll(
    'SELECT change_type, COUNT(*) as n FROM change_log WHERE client_id = ? AND accepted_at IS NULL GROUP BY change_type',
    [req.params.clientId]
  );
  const s = { new: 0, deleted: 0, modified: 0, solicitud: 0, total: 0 };
  counts.forEach(r => { s[r.change_type] = r.n; s.total += r.n; });
  res.json({ ok: true, pending: s });
});

// GET /api/snapshots/:clientId
app.get('/api/snapshots/:clientId', auth, async (req, res) => {
  const rows = await dbAll(
    'SELECT id,client_id,sheet_name,saved_at,saved_by,row_count FROM snapshots WHERE client_id=? ORDER BY id DESC LIMIT 20',
    [req.params.clientId]
  );
  res.json({ ok: true, snapshots: rows });
});

// DELETE /api/snapshots/:clientId
app.delete('/api/snapshots/:clientId', auth, async (req, res) => {
  await dbRun('DELETE FROM snapshots WHERE client_id=?', [req.params.clientId]);
  res.json({ ok: true, message: 'Snapshots eliminados' });
});

app.listen(PORT, () => {
  console.log(`✓ API corriendo en puerto ${PORT}`);
  console.log(`  Google API Key: ${process.env.GOOGLE_API_KEY ? 'OK' : 'FALTA'}`);
  console.log(`  API Secret: ${process.env.API_SECRET ? 'OK' : 'FALTA'}`);
  const PORT2 = process.env.PORT || 3000;
  console.log('Puerto asignado:', PORT2);
});
