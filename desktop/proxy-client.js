const fs = require('node:fs');
const path = require('node:path');

function serviceUrl(value) {
  const url = new URL(String(value || '').trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('O endereço do serviço Gemini deve usar HTTPS. HTTP é permitido apenas em localhost para testes.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Informe somente o endereço base do serviço Gemini.');
  return url.toString().replace(/\/$/, '');
}

async function createProxyClient(address, accessCode, fetchImpl = fetch) {
  const base = serviceUrl(address);
  const code = String(accessCode || '').trim();
  if (!code) throw new Error('Informe seu código de acesso ao serviço Gemini.');

  async function request(route, body) {
    const response = await fetchImpl(`${base}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${code}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Resposta inválida do serviço Gemini (HTTP ${response.status}).`); }
    if (!response.ok) {
      const error = new Error(String(result.error || `HTTP ${response.status}`).slice(0, 300));
      error.status = response.status;
      throw error;
    }
    return result;
  }

  const info = await request('/v1/info');
  if (!/^[a-zA-Z0-9._-]+$/.test(info.model || '') || info.promptVersion !== 1) {
    throw new Error('O serviço Gemini está em uma versão incompatível com este aplicativo.');
  }
  return {
    info,
    async generateImage(image) {
      const data = fs.readFileSync(image.file).toString('base64');
      const mimeType = path.extname(image.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      const result = await request('/v1/generate', { relative: image.relative, mimeType, data });
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('O serviço Gemini retornou texto vazio.');
      return result.text.trim();
    },
  };
}

module.exports = { createProxyClient, serviceUrl };
