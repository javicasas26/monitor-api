// src/db.js  — SQLite puro en JS (sin módulos nativos, funciona en Railway sin config extra)
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'monitor.db');

// db es una promesa que resuelve al objeto Database listo para usar
let _db = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  // Cargar desde disco si existe
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  // Crear tablas
  _db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT NOT NULL,
      sheet_url   TEXT NOT NULL,
      sheet_name  TEXT NOT NULL,
      saved_at    TEXT NOT NULL,
      saved_by    TEXT NOT NULL,
      row_count   INTEGER NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     TEXT NOT NULL,
      sheet_url     TEXT NOT NULL,
      detected_at   TEXT NOT NULL,
      detected_by   TEXT NOT NULL,
      sku           TEXT NOT NULL,
      change_type   TEXT NOT NULL,
      row_num       INTEGER,
      solicitud     TEXT,
      diffs         TEXT,
      accepted_at   TEXT,
      accepted_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_client   ON change_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_log_sku      ON change_log(sku);
    CREATE INDEX IF NOT EXISTS idx_snap_client  ON snapshots(client_id);
  `);

  persist();
  return _db;
}

// Guarda el archivo en disco después de cada escritura
function persist() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('Error persistiendo DB:', e.message);
  }
}

// Wrappers sincrónicos sobre sql.js (que es síncrono internamente)
// pero devolvemos async para no romper el código que los llama con await
async function run(sql, params = []) {
  const db = await getDb();
  db.run(sql, params);
  persist();
}

async function get(sql, params = []) {
  const db  = await getDb();
  const res = db.exec(sqlWithParams(sql, params));
  if (!res.length || !res[0].values.length) return undefined;
  return rowToObj(res[0].columns, res[0].values[0]);
}

async function all(sql, params = []) {
  const db  = await getDb();
  const res = db.exec(sqlWithParams(sql, params));
  if (!res.length) return [];
  return res[0].values.map(v => rowToObj(res[0].columns, v));
}

async function runMany(fn) {
  // fn recibe { run, get, all } síncronos y ejecuta una transacción
  const db = await getDb();
  fn({ run: db.run.bind(db), get: (s,p) => {
    const r = db.exec(sqlWithParams(s,p));
    if (!r.length || !r[0].values.length) return undefined;
    return rowToObj(r[0].columns, r[0].values[0]);
  }});
  persist();
}

// sql.js no tiene placeholders tipo ?, usar interpolación segura
function sqlWithParams(sql, params) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

function rowToObj(cols, vals) {
  const obj = {};
  cols.forEach((c, i) => { obj[c] = vals[i]; });
  return obj;
}

module.exports = { run, get, all, runMany, persist };
