const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const client = require('./gemini-client');
const writer = require('./gerar-manual');

test('404 e 403 não repetem; 503/429 esperam; quota diária interrompe', () => {
    assert.equal(client.retryDelay({ status: 404 }, 0), null);
    assert.equal(client.retryDelay({ status: 403 }, 0), null);
    assert.equal(client.retryDelay({ status: 503 }, 0, () => 0), 15000);
    assert.equal(client.retryDelay({ status: 503 }, 2, () => 0), 60000);
    assert.equal(client.retryDelay({ status: 429, errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
    ] }, 0, () => 0), 42000);
    assert.equal(client.retryDelay({ status: 429, errorDetails: [
        { violations: [{ quotaId: 'GenerateRequestsPerDay' }] },
    ] }, 0), null);
    assert.equal(client.retryDelay({ status: 429, message: 'Quota exceeded, limit: 0' }, 0), null);
});

test('limite de tentativas sem espera depois da última falha', async () => {
    let calls = 0;
    const waits = [];
    await assert.rejects(client.withRetry(async () => {
        calls++; throw Object.assign(new Error('busy'), { status: 503 });
    }, { attempts: 3 }, { wait: async ms => waits.push(ms), log: () => {} }));
    assert.equal(calls, 3);
    assert.equal(waits.length, 2);
    calls = 0;
    await assert.rejects(client.withRetry(async () => {
        calls++; throw Object.assign(new Error('missing'), { status: 404 });
    }, { attempts: 3 }, { wait: async () => assert.fail('não deve esperar') }));
    assert.equal(calls, 1);
});

test('listagem pagina, filtra generateContent e mantém chave fora da URL', async () => {
    let calls = 0;
    const models = await client.listModels({ apiKey: 'segredo', timeoutMs: 1000, attempts: 1 }, async (url, options) => {
        assert.equal(url.searchParams.has('key'), false);
        assert.equal(options.headers['x-goog-api-key'], 'segredo');
        calls++;
        if (calls === 2) assert.equal(url.searchParams.get('pageToken'), 'segunda');
        return { ok: true, json: async () => calls === 1
            ? { models: [{ name: 'models/a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'segunda' }
            : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }] } };
    });
    assert.equal(calls, 2);
    assert.deepEqual(models.map(m => m.name), ['models/a']);
});

test('erro de catálogo é preservado sem TypeError em data.models', async () => {
    await assert.rejects(client.listModels({ apiKey: 'segredo', timeoutMs: 1000, attempts: 1 }, async () => ({
        ok: false, status: 403, headers: new Headers(), json: async () => ({ error: { message: 'Permissão negada' } }),
    })), /Permissão negada/);
});

test('MIME, resposta incompleta e ocultação da chave', () => {
    assert.equal(writer.mimeType('captura.PNG'), 'image/png');
    assert.equal(writer.mimeType('captura.jpeg'), 'image/jpeg');
    assert.throws(() => client.responseText({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /não concluída/);
    assert.throws(() => client.responseText({ candidates: [{ finishReason: 'STOP' }], text: () => '' }), /vazio/);
    assert.equal(client.safeMessage(new Error('token secreto'), 'secreto'), 'token [CHAVE OCULTA]');
});

test('retoma, invalida imagem alterada e preserva progresso após falha', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-test-'));
    try {
        const run = path.join(root, 'artifacts', '2026-10-06T13-34-23-690Z');
        fs.mkdirSync(path.join(run, 'Modulo'), { recursive: true });
        fs.writeFileSync(path.join(run, 'Modulo', '1.jpg'), 'fake-jpeg');
        fs.writeFileSync(path.join(run, 'Modulo', '2.png'), 'fake-png');
        fs.writeFileSync(path.join(run, 'MANUAL_FINAL.md'), 'manual anterior');
        let calls = 0, fail = false, catalogCalls = 0;
        const fakeClient = { ...client,
            readConfig: () => ({ model: 'modelo-teste', attempts: 1, intervalMs: 0 }),
            createModel: async () => { catalogCalls++; return { generateContent: async parts => {
                calls++;
                if (fail) throw Object.assign(new Error('indisponível'), { status: 503 });
                assert.match(parts[1].inlineData.mimeType, /^image\/(jpeg|png)$/);
                return { response: { candidates: [{ finishReason: 'STOP' }], text: () => 'Descrição validada.' } };
            } }; }, sleep: async () => {},
        };
        const sandbox = { require: name => name === './gemini-client' ? fakeClient : require(name),
            __dirname: root, module: { exports: {} }, process, console: { log() {}, error() {} }, Buffer };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'gerar-manual.js'), 'utf8'), sandbox);
        const { main } = sandbox.module.exports;
        await main(['--limite=1']);
        assert.equal(calls, 1);
        assert.match(fs.readFileSync(path.join(run, 'MANUAL_FINAL.md'), 'utf8'), /1\/2/);
        const backup = fs.readdirSync(run).find(name => name.endsWith('.bak'));
        assert.equal(fs.readFileSync(path.join(run, backup), 'utf8'), 'manual anterior');
        fail = true;
        await assert.rejects(main([]), /indisponível/);
        assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(run, 'manual-progresso.json'))).entries).length, 1);
        assert.equal(fs.existsSync(path.join(run, '.gerar-manual.lock')), false);
        fail = false;
        await main([]);
        assert.equal(calls, 3);
        assert.match(fs.readFileSync(path.join(run, 'MANUAL_FINAL.md'), 'utf8'), /2\/2/);
        await main([]);
        assert.equal(calls, 3);
        assert.equal(catalogCalls, 3);
        fs.writeFileSync(path.join(run, 'Modulo', '1.jpg'), 'imagem alterada');
        await main([]);
        assert.equal(calls, 4);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
