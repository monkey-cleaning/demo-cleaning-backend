import axios from 'axios';

const config = {
  clientId: '1000.4J1PM03J3VVOI9BO115NP6CM93MG1U',
  clientSecret: 'a96dfd9d611fbf74dc3c23b8605be8428086bd4bda', 
  redirectUri: 'https://landing-monkey-backend.onrender.com/auth/zoho/callback'
};

async function generateToken() {
  console.log('🔐 Generando tokens Zoho...\n');
  
  // Paso 1: Obtener código de autorización (hazlo manualmente)
  const authUrl = `https://accounts.zohocloud.ca/oauth/v2/auth?scope=ZohoCRM.modules.ALL&client_id=${config.clientId}&response_type=code&access_type=offline&redirect_uri=${encodeURIComponent(config.redirectUri)}`;
  
  console.log('1. Abre esta URL en tu navegador:');
  console.log(authUrl);
  console.log('\n2. Después de autorizar, copia el "code" de la URL');
  console.log('3. Pega el código aquí:');
  
  // Simulamos entrada de usuario (en realidad necesitarías readline)
  const authCode = 'PEGA_AQUI_EL_CODIGO'; // Reemplaza con el código real
  
  try {
    // Paso 2: Intercambiar código por tokens
    const response = await axios.post('https://accounts.zohocloud.ca/oauth/v2/token', null, {
      params: {
        code: authCode,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      }
    });

    console.log('\n✅ ¡ÉXITO! Tokens generados:');
    console.log('Access Token:', response.data.access_token);
    console.log('Refresh Token:', response.data.refresh_token);
    console.log('\n📝 Agrega a tu .env:');
    console.log(`ZOHO_REFRESH_TOKEN=${response.data.refresh_token}`);
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

generateToken();