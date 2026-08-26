import jwt from 'jsonwebtoken';

const { ADMIN_JWT_SECRET } = process.env;

if (!ADMIN_JWT_SECRET) {
  console.warn('⚠️ ADMIN_JWT_SECRET is missing in .env (required for admin blogs)');
}

export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.role !== 'blog-admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.admin = payload;
    next();
  } catch (err) {
    console.error('Admin auth error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}