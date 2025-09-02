// firebase-admin.js
const admin = require('firebase-admin');

// Usa variables de entorno para credenciales o App Default Credentials.
// Opción 1: GOOGLE_APPLICATION_CREDENTIALS apunta al JSON del service account.
// Opción 2: inyectar el JSON vía env FIREBASE_SERVICE_ACCOUNT (string).

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  } else {
    admin.initializeApp(); // Usará GOOGLE_APPLICATION_CREDENTIALS si está seteado
  }
}

module.exports = admin;
