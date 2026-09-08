import jwt from 'jsonwebtoken';
import { runWithActor } from '../lib/actorContext.js';

// El secreto se lee EN CADA REQUEST (no en el load del módulo): según el orden
// de imports, dotenv puede no haber corrido todavía cuando se evalúa este
// archivo.

export function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_JWT_SECRET;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, secret);
    if (payload.role !== 'blog-admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.admin = payload;
    // LAB418: propaga "quién hace este cambio" a recordHistory() sin pasarlo
    // por la firma de cada controller.
    runWithActor(
      { actor: payload.user || 'admin', source: 'platform' },
      () => next(),
    );
  } catch (err) {
    console.error('Admin auth error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}
