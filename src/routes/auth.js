// routes/auth.js
import express from 'express';
import axios from 'axios';

const router = express.Router();

// URLs base (las podés mover a .env si querés)
const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://landing-monkey-frontend.onrender.com';

const ZOHO_REDIRECT_URI =
  process.env.ZOHO_REDIRECT_URI ||
  'https://landing-monkey-backend.onrender.com/auth/zoho/callback';

// Endpoint para recibir el callback de Zoho
router.get('/auth/zoho/callback', async (req, res) => {
  console.log('=== ZOHO CALLBACK ===');
  console.log('Query params:', req.query);

  try {
    const { code, error } = req.query;

    // Si Zoho envía error en la query
    if (error) {
      console.error('❌ Error de Zoho en query:', error);
      const url = `${FRONTEND_URL}?zoho_error=${encodeURIComponent(String(error))}`;
      return res.redirect(url);
    }

    // Si no viene el code, no se puede hacer nada
    if (!code) {
      const url = `${FRONTEND_URL}?zoho_error=no_code`;
      return res.redirect(url);
    }

    console.log('✅ Código recibido:', code);

    // Validar que tengamos las credenciales
    if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) {
      console.error('❌ Falta ZOHO_CLIENT_ID o ZOHO_CLIENT_SECRET en .env');
      const url = `${FRONTEND_URL}?zoho_error=server_config`;
      return res.redirect(url);
    }

    // Intercambiar code por tokens
    const tokenResponse = await axios.post(
      'https://accounts.zohocloud.ca/oauth/v2/token',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code,
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          redirect_uri: ZOHO_REDIRECT_URI,
        },
      }
    );

    console.log(
      '✅ Respuesta COMPLETA de Zoho:',
      JSON.stringify(tokenResponse.data, null, 2)
    );

    const {
      access_token,
      refresh_token,
      api_domain,
      expires_in,
      token_type,
    } = tokenResponse.data;

    console.log('🔑 access_token recibido:', access_token ? 'OK' : 'MISSING');
    console.log('🔁 refresh_token recibido:', !!refresh_token);
    console.log('🌍 api_domain:', api_domain);
    console.log('⏱ expires_in:', expires_in);
    console.log('🔧 token_type:', token_type);

    if (!refresh_token) {
      console.log('⚠️ Zoho no devolvió refresh_token.');
      console.log('   - Probablemente ya se emitió antes para este usuario/app/scopes.');
      console.log('   - Si necesitás uno nuevo, revocá la app en Zoho y repetí el flujo.');
    } else {
      // 👉 Acá deberías guardar refresh_token en BD / storage seguro
      // Ejemplo (pseudo):
      // await saveZohoTokens({ refreshToken: refresh_token, apiDomain: api_domain });
    }

    // Redirigir al frontend solo con info mínima
    const redirectUrl =
      `${FRONTEND_URL}?zoho_success=1` +
      `&has_refresh=${refresh_token ? '1' : '0'}`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('❌ Error en callback Zoho:');
    const data = err?.response?.data;
    if (data) {
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error(err.message || err);
    }

    const url = `${FRONTEND_URL}?zoho_error=request_failed`;
    return res.redirect(url);
  }
});

export default router;
