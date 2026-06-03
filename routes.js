function requireAuth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  const user   = (req.headers['x-user'] || '').trim();
  if (!secret || secret !== process.env.API_SECRET)
    return res.status(401).json({ ok: false, error: 'API secret inválido' });
  if (!user)
    return res.status(400).json({ ok: false, error: 'Header x-user requerido' });
  const allowed = (process.env.ALLOWED_USERS || '').split(',').map(u=>u.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(user))
    return res.status(403).json({ ok: false, error: `Usuario "${user}" no autorizado` });
  req.user = user;
  next();
}
module.exports = { requireAuth };
