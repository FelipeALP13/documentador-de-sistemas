const crypto = require('node:crypto');
const token = crypto.randomBytes(32).toString('base64url');
console.log(`Código para o destinatário: ${token}`);
console.log(`Hash para DOCUMENTADOR_PROXY_TOKEN_HASHES: ${crypto.createHash('sha256').update(token).digest('hex')}`);
