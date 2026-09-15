import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { supabase } from '../supabaseClient.js';
import {
  verifyPassword,
  updateProfile,
  usernameTaken,
  isValidPassword,
  isValidEmail,
  isValidUsername,
} from '../services/appCredentials.js';

const router = express.Router();

// process.env se lee en cada handler, no en el load del módulo (dotenv puede
// no haber corrido todavía según el orden de imports de index.js).

// POST /api/admin/auth/login
// Body: { password } (legacy) | { username, password } (multiusuario)
//
// El modo multiusuario valida contra app_credentials (hasheado en DB, LAB429
// — portado de Monkey Cleaning) — cada admin puede editar su username/email/
// contraseña en su perfil (PATCH /profile) y recuperarla por mail
// (/api/auth/forgot-password). Reemplaza al mapa TEST_USERS. El modo legacy
// (password única, sin username) queda intacto, es un camino aparte.
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { ADMIN_BLOG_PASSWORD, ADMIN_JWT_SECRET } = process.env;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  let authenticated = false;
  let userLabel = 'admin';

  if (username) {
    const credential = await verifyPassword(username.toLowerCase(), password, 'blog-admin');
    if (credential) {
      authenticated = true;
      userLabel = credential.username;
    }
  } else {
    // Modo legacy: password única
    if (ADMIN_BLOG_PASSWORD && password === ADMIN_BLOG_PASSWORD) {
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
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== 'blog-admin') return res.status(403).json({ error: 'Forbidden' });
    res.json({ ok: true, user: payload.user });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// GET /api/admin/auth/profile — para precargar el modal de "My account".
// No aplica al modo legacy (password única, sin fila en app_credentials).
router.get('/profile', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_credentials')
      .select('username, email')
      .ilike('username', req.admin?.user)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'Account not found' });
    return res.json({ ok: true, username: data.username, email: data.email });
  } catch (e) {
    console.error('❌ [adminAuth] get profile:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/admin/auth/profile
// Body: { currentPassword, username?, email?, newPassword? }
router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, username, email, newPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ ok: false, error: 'currentPassword is required' });
    }

    const credential = await verifyPassword(req.admin?.user, currentPassword, 'blog-admin');
    if (!credential) {
      return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
    }

    const patch = {};
    if (username != null && username.trim().toLowerCase() !== credential.username) {
      if (!isValidUsername(username)) {
        return res.status(400).json({ ok: false, error: 'Username must be 3-30 letters, numbers, . _ or -' });
      }
      if (await usernameTaken(username, credential.id)) {
        return res.status(409).json({ ok: false, error: 'That username is already taken' });
      }
      patch.username = username;
    }
    if (email != null && email.trim() !== credential.email) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Please enter a valid email' });
      }
      patch.email = email;
    }
    if (newPassword != null && newPassword !== '') {
      if (!isValidPassword(newPassword)) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
      }
      patch.newPassword = newPassword;
    }

    if (Object.keys(patch).length === 0) {
      return res.json({ ok: true, usernameChanged: false });
    }

    await updateProfile(credential.id, patch);
    return res.json({ ok: true, usernameChanged: Boolean(patch.username) });
  } catch (e) {
    console.error('❌ [adminAuth] update profile:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
