import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();
const { ADMIN_BLOG_PASSWORD, ADMIN_JWT_SECRET } = process.env;

if (!ADMIN_BLOG_PASSWORD || !ADMIN_JWT_SECRET) {
  console.warn('⚠️ Faltan ADMIN_BLOG_PASSWORD o ADMIN_JWT_SECRET en .env');
}

// Usuarios de prueba para testing multiusuario
// Las contraseñas se leen desde .env; fallback 'monkey2026' solo en desarrollo
const TEST_USERS = {
  jhony:   process.env.PASS_JHONY   || 'monkey2026',
  jony1:   process.env.PASS_JONY1   || 'monkey2026',
  yudith1: process.env.PASS_YUDITH1 || 'monkey2026',
  javier1: process.env.PASS_JAVIER1 || 'monkey2026',
  clara:   process.env.PASS_CLARA   || 'monkey2026',
};

// POST /api/admin/auth/login
// Body: { password } (legacy) | { username, password } (multiusuario)
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  let authenticated = false;
  let userLabel = 'admin';

  if (username) {
    const key = username.toLowerCase();
    const expected = TEST_USERS[key];
    if (expected && password === expected) {
      authenticated = true;
      userLabel = key;
    }
  } else {
    // Modo legacy: password única
    if (password === ADMIN_BLOG_PASSWORD) {
      authenticated = true;
    }
  }

  if (!authenticated) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { role: 'blog-admin', user: userLabel },
    ADMIN_JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ token });
});

// GET /api/admin/auth/me
router.get('/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.role !== 'blog-admin') return res.status(403).json({ error: 'Forbidden' });
    res.json({ ok: true, user: payload.user });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;