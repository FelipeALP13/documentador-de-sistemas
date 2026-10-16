const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const expectedVersion = require('../package.json').version;
  const output = path.join(root, 'build-check', expectedVersion);
  fs.mkdirSync(output, { recursive: true });
  let saveRequests = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/save') { saveRequests++; res.end('Unexpected write'); }
    else if (url.pathname === '/forms') res.end('<form action="/forms-home" method="post"><input name="usuario_login"><input type="password" name="senha_login"><input type="submit" value="Entrar"></form>');
    else if (url.pathname === '/forms-home') res.end('<nav><a href="#">Clientes</a></nav><div><input type="button" value="Nova ficha" onclick="location.href=\'/new-form\'"></div>');
    else if (url.pathname === '/new-form') res.end('<h1>Nova ficha</h1><form action="/save" method="post"><input name="nome"><button type="submit">Salvar</button><button type="button" onclick="fetch(\'/save\')">Excluir</button><a href="#" data-toggle="tab">Geral</a><a href="#" data-toggle="tab" onclick="document.querySelector(\'h2\').textContent=\'Endereços\'">Endereço</a><h2>Dados gerais</h2></form>');
    else if (url.pathname === '/partial') res.end('<form action="/partial-home" method="post"><input name="usuario_login"><input type="password" name="senha_login"><input type="submit" value="Entrar"></form>');
    else if (url.pathname === '/partial-home') res.end(`<nav><a href="#" onclick="document.querySelector('h1').textContent='Consulta'">Consulta</a><a href="#" onclick="document.body.insertAdjacentHTML('beforeend','<div role=dialog style=position:fixed;inset:0;background:white;z-index:99>Deseja excluir?<button>OK</button></div>')">Operacional</a><a href="#" onclick="document.querySelector('h1').textContent='Financeiro'">FI</a></nav><h1>Início</h1>`);
    else if (url.pathname === '/') res.end('<title>Sistema de teste</title><form action="/home" method="post"><label>Usuário<input name="usuario_login"></label><label>Senha<input type="password" name="senha_login"></label><input type="submit" value="Entrar"></form>');
    else if (url.pathname === '/home') res.end('<nav><a href="/customers">Clientes</a><a href="/reports">Relatórios</a></nav><main><h1>Painel</h1></main>');
    else if (url.pathname === '/customers') res.end('<main><h1>Clientes</h1></main>');
    else if (url.pathname === '/reports') res.end('<main><h1>Relatórios</h1></main>');
    else res.end('<main><h1>Página de teste</h1></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, 'dist/win-unpacked/Documentador de Sistemas.exe'), env, timeout: 45000 });
    const window = await app.firstWindow();
    await window.waitForFunction(version => document.title === `Documentador de Sistemas ${version}`, expectedVersion);
    await window.locator('#password').fill('senha-visivel-ficticia');
    assert.equal(await window.locator('#password').getAttribute('type'), 'password');
    await window.locator('#togglePassword').click();
    assert.equal(await window.locator('#password').getAttribute('type'), 'text');
    assert.equal(await window.locator('#password').inputValue(), 'senha-visivel-ficticia');
    assert.equal(await window.locator('#togglePassword').getAttribute('aria-pressed'), 'true');
    await window.locator('#togglePassword').click();
    assert.equal(await window.locator('#password').getAttribute('type'), 'password');
    const scanResult = await window.evaluate(async ({ url, folder }) => window.documentador.scan({ url, user: 'conta-ficticia', password: 'senha-ficticia', folder, browser: 'msedge' }), { url: `http://127.0.0.1:${server.address().port}/`, folder: output });
    assert.equal(scanResult.ok, true, scanResult.error);
    assert.ok(scanResult.result.records > 0);
    assert.equal(scanResult.result.errors, 0);
    assert.equal(scanResult.result.records, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(scanResult.result.out, 'scan-manifest.json')));
    assert.deepEqual(manifest.records.map(record => record.label).sort(), ['Clientes', 'Relatórios']);
    const formsResult = await window.evaluate(async ({ url, folder }) => window.documentador.scan({ url, user: 'conta-ficticia', password: 'senha-ficticia', folder, browser: 'msedge' }), { url: `http://127.0.0.1:${server.address().port}/forms`, folder: output });
    assert.equal(formsResult.ok, true, formsResult.error);
    assert.equal(formsResult.result.errors, 0);
    const formsManifest = JSON.parse(fs.readFileSync(path.join(formsResult.result.out, 'scan-manifest.json')));
    assert.ok(formsManifest.records.some(record => record.kind === 'novo'));
    assert.ok(formsManifest.records.some(record => record.label === 'Clientes > Nova ficha > Endereço'));
    assert.equal(saveRequests, 0);
    await window.locator('#url').fill(`http://127.0.0.1:${server.address().port}/partial`);
    await window.locator('#user').fill('conta-ficticia');
    await window.locator('#password').fill('senha-ficticia');
    await window.locator('#folder').fill(output);
    await window.locator('#scan').click();
    await window.waitForFunction(() => document.getElementById('status').textContent === 'Varredura parcial', null, { timeout: 90000 });
    const partialStatus = await window.locator('#status').innerText();
    assert.match(await window.locator('#log').innerText(), /2 capturas, 1 erros, 0 menus pendentes/);
    await window.screenshot({ path: path.join(output, 'desktop.png') });
    const version = await app.evaluate(({ app }) => app.getVersion());
    const report = { version, packagedScan: scanResult, formsScan: formsResult, saveRequests, partialStatus, title: await window.title() };
    fs.writeFileSync(path.join(output, 'smoke-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
