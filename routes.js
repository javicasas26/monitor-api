// src/auth.js
// Middleware de autenticación simple por header

/**
 * Verifica que el request incluya:
 *   x-api-secret: <API_SECRET del .env>
 *   x-user:       <nombre del usuario que hace la acción>
 */
function requireAuth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  const user   = (req.headers['x-user'] || '').trim();

  if (!secret || secret !== process.env.API_SECRET) {
    return res.status(401).json({ ok: false, error: 'API secret inválido o ausente' });
  }

  if (!user) {
    return res.status(400).json({ ok: false, error: 'Header x-user requerido' });
  }

  // Validar usuario si hay lista configurada
  const allowed = (process.env.ALLOWED_USERS || '').split(',').map(u => u.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(user)) {
    return res.status(403).json({ ok: false, error: `Usuario "${user}" no autorizado` });
  }

  req.user = user;
  next();
}

module.exports = { requireAuth };
