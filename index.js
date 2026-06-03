const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'monitor.db');
let _db = null;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
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
    CREATE INDEX IF NOT EXISTS idx_log_client ON change_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_snap_client ON snapshots(client_id);
  `);
  persist();
  return _db;
}

function persist() {
  if (!_db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(_db.export())); } catch(e) { console.error('DB persist error:', e.message); }
}

function sqlWithParams(sql, params) {
  if (!params || !params.length) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    return `'${String(v).replace(/'/g,"''")}'`;
  });
}

function rowToObj(cols, vals) {
  const o = {};
  cols.forEach((c,i) => { o[c] = vals[i]; });
  return o;
}

async function run(sql, params=[]) {
  const db = await getDb();
  db.run(sqlWithParams(sql, params));
  persist();
}

async function get(sql, params=[]) {
  const db  = await getDb();
  const res = db.exec(sqlWithParams(sql, params));
  if (!res.length || !res[0].values.length) return undefined;
  return rowToObj(res[0].columns, res[0].values[0]);
}

async function all(sql, params=[]) {
  const db  = await getDb();
  const res = db.exec(sqlWithParams(sql, params));
  if (!res.length) return [];
  return res[0].values.map(v => rowToObj(res[0].columns, v));
}

async function runMany(fn) {
  const db = await getDb();
  fn({
    run: (s,p) => db.run(sqlWithParams(s,p)),
    get: (s,p) => {
      const r = db.exec(sqlWithParams(s,p));
      if (!r.length || !r[0].values.length) return undefined;
      return rowToObj(r[0].columns, r[0].values[0]);
    }
  });
  persist();
}

module.exports = { run, get, all, runMany };
