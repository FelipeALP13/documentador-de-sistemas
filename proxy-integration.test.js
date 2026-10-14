const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHandler, tokenHash } = require('./proxy/server');
const { createProxyClient, serviceUrl } = require('./desktop/proxy-client');
const { main: generate } = require('./gerar-manual');

test('serviço usa a chave apenas no servidor e gera o manual pelo cliente', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-proxy-test-'));
  const run = path.join(root, 'artifacts', '2026-10-08T00-00-00-000Z');
  const folder = path.join(run, 'Modulo');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'geral.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const code = 'a'.repeat(32);
  let upstreamRequest;
  const fakeGoogle = async (_url, options) => {
    upstreamRequest = options;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Tela de teste documentada.' }] } }] }) };
  };
  const server = http.createServer(createHandler({ apiKey: 'server-only-key', model: 'gemini-test', tokenHashes: [tokenHash(code)] }, fakeGoogle));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${url}/v1/info`, { headers: { Authorization: `Bearer ${'b'.repeat(32)}` } });
    assert.equal(denied.status, 401);
    const client = await createProxyClient(url, code);
    assert.equal(client.info.model, 'gemini-test');
    await generate([], {
      artifactsRoot: path.join(root, 'artifacts'),
      config: { apiKey: '', model: client.info.model, intervalMs: 0, timeoutMs: 1000, attempts: 1 },
      generateImage: client.generateImage,
      log: () => {},
    });
    const manual = fs.readFileSync(path.join(run, 'MANUAL_FINAL.md'), 'utf8');
    assert.match(manual, /Tela de teste documentada/);
    assert.doesNotMatch(manual, /server-only-key/);
    assert.equal(upstreamRequest.headers['x-goog-api-key'], 'server-only-key');
    assert.equal(JSON.parse(upstreamRequest.body).contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const name of ['geral.jpg']) fs.unlinkSync(path.join(folder, name));
    for (const name of ['MANUAL_FINAL.md', 'manual-progresso.json']) fs.unlinkSync(path.join(run, name));
    fs.rmdirSync(folder); fs.rmdirSync(run); fs.rmdirSync(path.join(root, 'artifacts')); fs.rmdirSync(root);
  }
});

test('cliente exige HTTPS fora de localhost', () => {
  assert.throws(() => serviceUrl('http://exemplo.com'), /HTTPS/);
  assert.equal(serviceUrl('https://exemplo.com/'), 'https://exemplo.com');
});
