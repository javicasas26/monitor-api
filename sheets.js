// src/routes.js
const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { readSheet, computeDiff, clientId } = require('./sheets');
const { requireAuth } = require('./auth');

// ── GET /health ────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Monitor de Cambios API corriendo', ts: new Date().toISOString() });
});

// ── POST /load ─────────────────────────────────────────────────────────────
// Lee la planilla, compara con el snapshot más reciente, registra cambios.
router.post('/load', requireAuth, async (req, res) => {
  const {
    sheetUrl,
    sheetName   = 'Hoja 1',
    headerRow   = 2,
    skuKeyword  = 'Sku',
    solKeyword  = 'Solicitud'
  } = req.body;

  if (!sheetUrl) return res.status(400).json({ ok: false, error: 'sheetUrl es requerido' });

  try {
    // 1 — Leer planilla
    const { headerNames, skuColIdx, solColIdx, rows } = await readSheet({
      sheetUrl, sheetName, headerRow, skuKeyword, solKeyword
    });

    const cid        = clientId(sheetUrl);
    const solColName = solColIdx >= 0 ? headerNames[solColIdx] : null;

    // 2 — Obtener último snapshot
    const snapRow = await db.get(
      `SELECT * FROM snapshots WHERE client_id = ? ORDER BY id DESC LIMIT 1`,
      [cid]
    );

    let changes     = [];
    const isFirst   = !snapRow;

    if (snapRow) {
      const snapData = JSON.parse(snapRow.data);
      changes        = computeDiff(rows, snapData, solColName);

      // 3 — Insertar cambios nuevos (evita duplicar si ya hay uno pendiente igual)
      const now = new Date().toISOString();
      await db.runMany(({ run, get }) => {
        for (const ch of changes) {
          const exists = get(
            `SELECT id FROM change_log WHERE client_id = ? AND sku = ? AND change_type = ? AND accepted_at IS NULL`,
            [cid, ch.sku, ch.changeType]
          );
          if (!exists) {
            run(
              `INSERT INTO change_log
                (client_id, sheet_url, detected_at, detected_by, sku, change_type, row_num, solicitud, diffs)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [cid, sheetUrl, now, req.user, ch.sku, ch.changeType,
               ch.rowNum, ch.solicitud || '', JSON.stringify(ch.diffs || [])]
            );
          }
        }
      });
    }

    res.json({
      ok: true,
      clientId:     cid,
      isFirstLoad:  isFirst,
      loadedBy:     req.user,
      loadedAt:     new Date().toISOString(),
      totalRows:    rows.length,
      detectedCols: {
        sku:       skuColIdx >= 0 ? { index: skuColIdx, name: headerNames[skuColIdx] } : null,
        solicitud: solColIdx >= 0 ? { index: solColIdx, name: headerNames[solColIdx] } : null,
      },
      snapshot: snapRow ? {
        savedAt:  snapRow.saved_at,
        savedBy:  snapRow.saved_by,
        rowCount: snapRow.row_count,
      } : null,
      summary: {
        new:       changes.filter(c => c.changeType === 'new').length,
        deleted:   changes.filter(c => c.changeType === 'deleted').length,
        modified:  changes.filter(c => c.changeType === 'modified').length,
        solicitud: changes.filter(c => c.changeType === 'solicitud').length,
      },
      changes,
      rows,
      headerNames,
    });

  } catch (err) {
    console.error('[/load]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /snapshot ─────────────────────────────────────────────────────────
// Guarda el estado actual como base de comparación.
router.post('/snapshot', requireAuth, async (req, res) => {
  const { sheetUrl, sheetName = 'Hoja 1', rows } = req.body;
  if (!sheetUrl)          return res.status(400).json({ ok: false, error: 'sheetUrl requerido' });
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows debe ser array' });

  const cid = clientId(sheetUrl);
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO snapshots (client_id, sheet_url, sheet_name, saved_at, saved_by, row_count, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cid, sheetUrl, sheetName, now, req.user, rows.length, JSON.stringify(rows)]
  );

  res.json({ ok: true, clientId: cid, savedAt: now, savedBy: req.user, rowCount: rows.length });
});

// ── POST /accept ───────────────────────────────────────────────────────────
// Acepta todos los cambios pendientes y guarda snapshot en una sola operación.
router.post('/accept', requireAuth, async (req, res) => {
  const { sheetUrl, sheetName = 'Hoja 1', rows } = req.body;
  if (!sheetUrl)          return res.status(400).json({ ok: false, error: 'sheetUrl requerido' });
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows debe ser array' });

  const cid = clientId(sheetUrl);
  const now = new Date().toISOString();
  let accepted = 0;

  await db.runMany(({ run, get }) => {
    // Contar pendientes antes de aceptar
    const count = get(
      `SELECT COUNT(*) as n FROM change_log WHERE client_id = ? AND accepted_at IS NULL`,
      [cid]
    );
    accepted = count ? count.n : 0;

    run(
      `UPDATE change_log SET accepted_at = ?, accepted_by = ? WHERE client_id = ? AND accepted_at IS NULL`,
      [now, req.user, cid]
    );
    run(
      `INSERT INTO snapshots (client_id, sheet_url, sheet_name, saved_at, saved_by, row_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cid, sheetUrl, sheetName, now, req.user, rows.length, JSON.stringify(rows)]
    );
  });

  res.json({ ok: true, acceptedChanges: accepted, savedAt: now, savedBy: req.user });
});

// ── GET /log/:clientId ─────────────────────────────────────────────────────
// Historial de cambios. Query: limit, offset, changeType, sku, pending
router.get('/log/:clientId', requireAuth, async (req, res) => {
  const cid = req.params.clientId;
  const { limit = 100, offset = 0, changeType, sku, pending } = req.query;

  let where  = 'WHERE client_id = ?';
  const args = [cid];

  if (changeType)       { where += ' AND change_type = ?';     args.push(changeType); }
  if (sku)              { where += ' AND sku LIKE ?';           args.push(`%${sku}%`); }
  if (pending === 'true')  { where += ' AND accepted_at IS NULL'; }
  if (pending === 'false') { where += ' AND accepted_at IS NOT NULL'; }

  const rows  = await db.all(
    `SELECT * FROM change_log ${where} ORDER BY detected_at DESC LIMIT ? OFFSET ?`,
    [...args, parseInt(limit), parseInt(offset)]
  );
  const total = await db.get(`SELECT COUNT(*) as n FROM change_log ${where}`, args);

  res.json({
    ok: true,
    total: total?.n || 0,
    rows: rows.map(r => ({ ...r, diffs: JSON.parse(r.diffs || '[]') })),
  });
});

// ── GET /log/:clientId/summary ─────────────────────────────────────────────
router.get('/log/:clientId/summary', requireAuth, async (req, res) => {
  const cid    = req.params.clientId;
  const counts = await db.all(
    `SELECT change_type, COUNT(*) as n FROM change_log WHERE client_id = ? AND accepted_at IS NULL GROUP BY change_type`,
    [cid]
  );
  const summary = { new: 0, deleted: 0, modified: 0, solicitud: 0, total: 0 };
  counts.forEach(r => { summary[r.change_type] = r.n; summary.total += r.n; });
  res.json({ ok: true, pending: summary });
});

// ── GET /snapshots/:clientId ───────────────────────────────────────────────
router.get('/snapshots/:clientId', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT id, client_id, sheet_name, saved_at, saved_by, row_count FROM snapshots WHERE client_id = ? ORDER BY id DESC LIMIT 20`,
    [req.params.clientId]
  );
  res.json({ ok: true, snapshots: rows });
});

// ── DELETE /snapshots/:clientId ────────────────────────────────────────────
router.delete('/snapshots/:clientId', requireAuth, async (req, res) => {
  await db.run('DELETE FROM snapshots WHERE client_id = ?', [req.params.clientId]);
  res.json({ ok: true, message: 'Snapshots eliminados' });
});

module.exports = router;
