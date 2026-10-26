const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const ui = require('./crawler-interface');
const { main: scan, browserLaunchOptions, browserContextOptions, maximizePageWindow } = require('./varredura-completa');
const { waitForInterface } = require('./crawler-ui-state');
const { walkMenus } = require('./crawler-navigation');
const { exploreContent, controls: contentControls, transientLoaderNavigation } = require('./crawler-content');
const { attachNetworkMonitor } = require('./crawler-network');
const { analyzeJpeg, takeUsableScreenshot, restoreSuppressedLoading } = require('./crawler-image');
const jpeg = require('jpeg-js');

let server, base, browser, expireRequests = 0, spaLoginRequests = 0, spaFormLoginRequests = 0, opaqueWrites = 0, readPosts = 0, lateTreeRequests = 0;
const requests = [];
const modern = `<form action="/modern-home"><input type="search" placeholder="Pesquisar"><input id="email" autocomplete="username"><input id="senha" type="password"><button type="submit">Entrar</button></form>`;
const legacy = `<title>Sistema legado</title><form id="frmLogin" action="/frames"><label for="usuario">Usuário</label><input id="usuario" name="usuario_login"><input id="senha" name="senha_login" type="password"><input type="submit" value="Entrar"></form>`;
before(async () => {
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    requests.push(route);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (route === '/missing.jsp') { res.statusCode = 404; res.end('Not found'); return; }
    if (route === '/opaque-write') { opaqueWrites++; res.end('alterado'); return; }
    if (route === '/read-screen') { readPosts++; res.end('<h1>Tela consultada por POST</h1><p>Conteúdo correto</p>'); return; }
    if (route === '/late-tree-data') { lateTreeRequests++; res.end(`<a href="#" onclick="document.querySelector('main').textContent='Cadastro tardio carregado'">Cadastro tardio</a>`); return; }
    if (route === '/reauth-home') {
      if (req.method === 'POST') res.end(`<nav><a href="/expire-once">Relatório protegido</a></nav><main>Sessão ativa</main>`);
      else res.end(`<form action="/reauth-home" method="post"><input name="usuario_login"><input type="password" name="senha_login"><button type="submit">Entrar</button></form>`);
      return;
    }
    if (route === '/expire-once') {
      expireRequests++;
      res.end(expireRequests === 1
        ? `<form action="/reauth-home" method="post"><input name="usuario_login"><input type="password" name="senha_login"><button type="submit">Entrar</button></form>`
        : `<main>Relatório após nova autenticação</main>`);
      return;
    }
    if (route === '/spa-home') {
      if (req.method !== 'POST') { res.statusCode = 404; res.end('A rota interna não aceita recarregamento direto'); return; }
      res.end(`<nav><a href="/missing.jsp">Indisponível</a><a href="#" onclick="document.querySelector('main').textContent='Consulta disponível'">Consulta</a></nav><main>Aplicação autenticada</main>`);
      return;
    }
    if (route === '/spa-form-home') {
      if (req.method !== 'POST') { res.statusCode = 404; res.end('A rota interna do formulário não aceita recarregamento direto'); return; }
      res.end(`<nav><button type="button" onclick="showList()">Cadastros</button></nav><main></main><script>function showList(){document.querySelector('main').innerHTML='<h1>Cadastros</h1><button type="button" onclick="showForm()">Novo cliente</button>'}function showForm(){document.querySelector('main').innerHTML='<h1>Novo cliente</h1><form><input name="nome"><button type="submit">Salvar</button></form>'}showList()</script>`);
      return;
    }
    if (route === '/spa-login') {
      spaLoginRequests++;
      res.end(`<form action="/spa-home" method="post"><input autocomplete="username"><input type="password"><button type="submit">Entrar</button></form>`);
      return;
    }
    if (route === '/spa-form-login') {
      spaFormLoginRequests++;
      res.end(`<form action="/spa-form-home" method="post"><input autocomplete="username"><input type="password"><button type="submit">Entrar</button></form>`);
      return;
    }
    const pages = {
      '/modern': modern,
      '/modern-home': `<nav><a href="#" onclick="document.querySelector('main').textContent='Painel de vendas'">Visão geral</a><div class="grupo"><a href="#" aria-expanded="false" onclick="this.nextElementSibling.hidden=false;this.setAttribute('aria-expanded','true')">Cadastros</a><div hidden><a href="#" onclick="document.querySelector('main').innerHTML='<h1>Clientes</h1>'">Clientes</a></div></div><a href="/logout">Sair</a></nav><main>Bem-vindo</main>`,
      '/legacy': legacy,
      '/nested': `<iframe src="/wrapper"></iframe>`,
      '/wrapper': `<iframe src="/legacy"></iframe>`,
      '/frames': `<frameset cols="25%,75%"><frame name="menu" src="/menu"><frame name="conteudo" src="/welcome"></frameset>`,
      '/menu': `<div id="menuPrincipal"><a href="/clientes.jsp" target="conteudo">Clientes</a><a href="/relatorios.jsp" target="conteudo">Relatórios</a><a href="javascript:location='/logout'">Sair</a><a href="/delete">Excluir</a></div>`,
      '/welcome': `<h1>Bem-vindo ao sistema legado</h1>`,
      '/clientes.jsp': `<h1>Cadastro de clientes</h1><p>Conteúdo dentro do frame</p>`,
      '/relatorios.jsp': `<h1>Relatórios gerenciais</h1><button role="tab">Resumo</button><button role="tab" onclick="document.querySelector('h1').textContent='Detalhes financeiros'">Detalhes</button>`,
      '/rejected': `<title>Acesso negado</title><form onsubmit="event.preventDefault()"><input name="login"><input type="password"><button>Entrar</button></form>`,
      '/rejected-message': `<title>Acesso negado</title><form><input name="login"><input type="password"><button type="submit">Entrar</button></form><script>document.querySelector('form').onsubmit=event=>{event.preventDefault();const container=document.createElement('div');container.id='dialogContainer';const dialog=document.createElement('div');dialog.className='dialog dialog-error';dialog.textContent='Usuário ou senha inválidos.';const close=document.createElement('button');close.id='dialog-close-button';close.type='submit';close.textContent='Fechar';dialog.append(close);container.append(dialog);document.body.append(container)}</script>`,
      '/unusual': `<form action="/modern-home"><input placeholder="Matrícula"><input type="password"><input type="image" alt="Acessar" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></form>`,
      '/animated-login': `<style>.entering{transform:translateX(200vw);pointer-events:none}</style><form class="entering" action="/modern-home"><input id="animated-user" autocomplete="username"><input id="animated-password" type="password"><button type="submit">Entrar</button></form><script>setTimeout(()=>document.querySelector('form').classList.remove('entering'),650)</script>`,
      '/covered-login': `<form action="/modern-home"><input autocomplete="username"><input type="password"><button type="submit">Entrar</button></form><div style="position:fixed;inset:0;z-index:10"></div>`,
      '/delayed-menu-login': modern.replace('/modern-home','/delayed-menu-home'),
      '/delayed-menu-home': `<main>Carregando módulos</main><script>setTimeout(()=>{const nav=document.createElement('nav');const link=document.createElement('a');link.href='#';link.textContent='Módulo tardio';link.onclick=()=>document.querySelector('main').textContent='Módulo carregado';nav.append(link);document.body.prepend(nav)},2200)</script>`,
      '/delayed-form-login': modern.replace('/modern-home','/delayed-form-home'),
      '/delayed-form-home': `<nav><a href="#" onclick="openList()">Cadastros</a></nav><main>Início</main><script>function openList(){document.querySelector('main').innerHTML='<h1>Clientes</h1><button type=button onclick=openForm()>Novo cliente</button>'}function openForm(){document.body.insertAdjacentHTML('beforeend','<div class=loading-overlay style=position:fixed;inset:0;background:white;z-index:99><div class=spinner style=margin:70px;width:70px;height:70px;border:12px solid #eee;border-top-color:#d55;border-radius:50%></div></div>');setTimeout(()=>{document.querySelector('.loading-overlay').remove();document.querySelector('main').innerHTML='<h1>Novo cliente carregado</h1><form><input name=nome><button type=submit>Salvar</button></form>'},900)}</script>`,
      '/stale-form-login': modern.replace('/modern-home','/stale-form-home'),
      '/stale-form-home': `<nav><a href="#" onclick="openList()">Cadastros</a></nav><main>Início</main><script>function openList(){document.querySelector('main').innerHTML='<h1>Clientes</h1><button type=button onclick=openForm()>Novo cliente</button>'}function openTab(){document.querySelector('h2').textContent='Endereços'}function openForm(){document.querySelector('main').innerHTML='<h1>Novo cliente pronto</h1><form><input name=nome><button type=button data-toggle=tab onclick=openTab()>Endereço</button><h2>Dados gerais</h2><button type=submit>Salvar</button></form>';document.body.insertAdjacentHTML('beforeend','<div class=screen-mask style=position:fixed;inset:0;background:white;z-index:99><div class=adornment></div></div>')}</script>`,
      '/loader-navigation-home': `<main><h1>Clientes</h1></main><iframe src="/loader-navigation-frame"></iframe><script>function openForm(frame){frame.src='/img/loader_base.svg';setTimeout(()=>frame.src='/loader-navigation-form',200)}</script>`,
      '/loader-navigation-frame': `<button type="button" onclick="parent.openForm(window.frameElement)">Novo cliente</button>`,
      '/img/loader_base.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>`,
      '/loader-navigation-form': `<main><h1>Novo cliente carregado após o loader</h1><form><label>Nome<input name="nome"></label><button type="submit">Salvar</button></form></main>`,
      '/late-tree-login': modern.replace('/modern-home','/late-tree-home'),
      '/late-tree-home': `<nav><a href="#" onclick="document.querySelector('main').textContent='Dashboard carregado'">Dashboard</a></nav><main>Início</main><script>setTimeout(()=>fetch('/late-tree-data',{method:'POST'}).then(response=>response.text()).then(html=>document.querySelector('nav').insertAdjacentHTML('beforeend',html)),700)</script>`,
      '/alert-login': modern.replace('/modern-home','/alert-home'),
      '/alert-home': `<style>.swal2-container,.blockOverlay{position:fixed;inset:0;background:#0008;z-index:10}.swal2-popup{background:white;margin:100px;padding:20px}.blockOverlay{z-index:20}</style><nav><a href="#" onclick="document.querySelector('main').textContent='BI - Operacional';setTimeout(showAlert,100)">Operacional</a><a href="#" onclick="document.querySelector('main').textContent='Lançamento financeiro'">FI</a></nav><main>Início</main><script>function showAlert(){const d=document.createElement('div');d.className='swal2-container';d.innerHTML='<div class="swal2-popup" role="dialog"><h2>Atenção!</h2><p>Sem dados para serem trabalhados</p><button type="button">OK</button></div>';d.querySelector('button').onclick=()=>d.remove();document.body.append(d);const loader=document.createElement('div');loader.className='blockUI blockOverlay';document.body.append(loader);setTimeout(()=>loader.remove(),900)}</script>`,
      '/blocked-login': modern.replace('/modern-home','/blocked-home'),
      '/two-step': `<form onsubmit="event.preventDefault();location='/two-step-password'"><label>Conta<input id="account" autocomplete="username"></label><button type="submit">Continuar</button></form>`,
      '/two-step-password': `<form onsubmit="event.preventDefault();location='/generic-home'"><label>Senha<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Entrar</button></form>`,
      '/generic-home': `<main><h1>Página inicial</h1><p>Login em duas etapas concluído.</p></main>`,
      '/single-login': modern.replace('/modern-home','/single-home'),
      '/single-home': `<main><h1>Painel</h1><a href="/details">Detalhes da conta</a></main>`,
      '/details': `<main><h1>Detalhes da conta</h1><button type="button" onclick="openContact()">Adicionar contato</button></main><template id="contact"><h1>Novo contato</h1><form><input name="nome"><button type="submit">Salvar</button><button role="tab" type="button" onclick="document.querySelector('h2').textContent='Endereços'">Endereço</button><h2>Dados gerais</h2></form></template><script>function openContact(){document.querySelector('main').replaceChildren(document.querySelector('#contact').content.cloneNode(true))}</script>`,
      '/bootstrap-login': modern.replace('/modern-home','/bootstrap-home'),
      '/bootstrap-home': `<div class="navbar"><ul class="nav navbar-nav"><li class="dropdown"><a class="dropdown-toggle" href="#" onclick="this.nextElementSibling.hidden=false">BI</a><ul class="dropdown-menu" hidden><li><a href="#" onclick="document.querySelector('main').textContent='Painel analítico'">Painel</a></li></ul></li><li class="dropdown"><a class="dropdown-toggle" href="#" onclick="this.nextElementSibling.hidden=false">Financeiro</a><ul class="dropdown-menu" hidden><li><a href="#" onclick="document.querySelector('main').textContent='Contas a pagar'">Contas</a></li></ul></li></ul></div><main>Início</main>`,
      '/header-login': modern.replace('/modern-home','/header-home'),
      '/header-home': `<header><ul><li><a href="#" onclick="this.nextElementSibling.hidden=false">BI</a><ul hidden><li><a href="#" onclick="document.querySelector('main').textContent='Painel SGE'">Painel</a></li></ul></li><li><a href="#" onclick="this.nextElementSibling.hidden=false">Financeiro</a><ul hidden><li><a href="#" onclick="document.querySelector('main').textContent='Lançamentos SGE'">Lançamentos</a></li></ul></li></ul></header><main>Início</main>`,
      '/script-login': modern.replace('/modern-home','/script-home'),
      '/script-home': `<nav><a href="#" onclick="document.querySelector('main').textContent='Tela disponível';document.querySelector('inexistente').valor=1">Relatório</a></nav><main>Início</main>`,
      '/noop-login': modern.replace('/modern-home','/noop-home'),
      '/noop-home': `<nav><a href="#" onclick="document.querySelector('main').innerHTML='<h1>Cadastros</h1><button type=button>Novo</button>'">Cadastros</a></nav><main>Início</main>`,
      '/settings-field-login': modern.replace('/modern-home','/settings-field-home'),
      '/settings-field-home': `<nav><a href="#" onclick="document.querySelector('main').hidden=false">Configuração</a></nav><main hidden><form><label>Conta<input name="account"></label><button type="button">Salvar</button></form></main>`,
      '/reauth-login': `<form action="/reauth-home" method="post"><input name="usuario_login"><input type="password" name="senha_login"><button type="submit">Entrar</button></form>`,
      '/forms-login': modern.replace('/modern-home','/forms-home'),
      '/forms-home': `<nav><a href="/forms-home">Cadastros</a></nav><div id="content"><h1>Lista de cadastros</h1><input type="button" value="Novo cliente" onclick="openForm('Cliente')"><a href="#" onclick="openForm('Proposta')">Criar uma nova proposta</a></div><template id="ficha"><div role="dialog"><h1>Ficha</h1><form action="/forbidden-save" method="post"><input name="nome"><button type="submit">Salvar</button><button type="button" onclick="fetch('/forbidden-delete')">Excluir</button><a href="#" data-toggle="tab" onclick="document.querySelector('h2').textContent='Dados gerais'">Geral</a><a href="#" data-toggle="tab" onclick="document.querySelector('h2').textContent='Endereços'">Endereço</a><h2>Dados gerais</h2></form></div></template><script>function openForm(name){const target=document.getElementById('content');target.replaceChildren(document.getElementById('ficha').content.cloneNode(true));target.querySelector('h1').textContent=name}</script>`,
      '/http-login': modern.replace('/modern-home','/http-home'),
      '/http-home': `<nav><a href="#" onclick="fetch('/missing.jsp?token=nao-registrar')">Solicitado</a><a href="/http-good">Consulta</a></nav><main>Início</main>`,
      '/http-good': `<main>Consulta disponível</main>`,
      '/mutation-login': modern.replace('/modern-home','/mutation-home'),
      '/mutation-home': `<nav><a href="#" onclick="fetch('/opaque-write',{method:'POST',body:'registro=1'}).catch(()=>{});document.querySelector('main').textContent='Consulta aberta'">Consulta</a></nav><main>Início</main>`,
      '/post-read-login': modern.replace('/modern-home','/post-read-home'),
      '/post-read-home': `<nav><a href="#" onclick="document.querySelector('main').textContent='Carregando';fetch('/read-screen',{method:'POST',body:'tela=clientes'}).then(response=>response.text()).then(html=>document.querySelector('main').innerHTML=html)">Clientes</a><a href="#" onclick="fetch('/save-record',{method:'POST',body:'acao=salvar'});document.querySelector('main').textContent='Não deveria abrir'">Salvar registro</a></nav><main>Início</main>`,
      '/frame-menu': `<nav><a href="/clientes.jsp">Clientes do frame</a></nav>`,
      '/blocked-home': `<nav><a href="#" onclick="document.querySelector('main').textContent='Consulta inicial'">Consulta</a><a href="#" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=dialog style=position:fixed;inset:0;background:white;z-index:99>Deseja excluir o cadastro?<button onclick=window.confirmed=true>OK</button></div>')">Operacional</a><a href="#" onclick="document.querySelector('main').textContent='Próxima tela'">FI</a></nav><main>Início</main>`,
    };
    res.end(pages[route] || '<title>Sem login</title><h1>Página sem formulário</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
async function newPage() {
  browser ||= await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  return context.newPage();
}
afterEach(async () => { await browser?.close(); browser = null; });
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
const credentials = route => ({ SISTEMA_URL: base + route, SISTEMA_USER: 'usuario-teste', SISTEMA_PASS: 'senha-"\\secreta' });

test('login moderno sem Leads; menu oculto e ações de saída ignoradas', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/modern');
    const form = await ui.findLogin(page);
    assert.equal(form.user.selector, '#email');
    assert.ok(await ui.findLogin(page, { strict: true }));
    const menus = await ui.login(page, credentials('/modern'), 3000);
    assert.ok(menus.some(e => e.name === 'Visão geral'));
    assert.ok(!menus.some(e => e.name === 'Sair'));
    assert.deepEqual(menus.find(e => e.name === 'Clientes').parentNames, ['Cadastros']);
    await ui.openMenu(page, menus.find(e => e.name === 'Clientes'));
    assert.equal(await page.locator('h1').innerText(), 'Clientes');
  } finally { await page.close(); }
});

test('sistema legado dentro de iframes aninhados, frameset e navegação target', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/nested');
    const menus = await ui.login(page, credentials('/nested'), 5000);
    assert.ok(menus.length >= 2);
    const clients = menus.find(e => e.name === 'Clientes');
    assert.ok(clients.framePath.length >= 3);
    await ui.openMenu(page, clients);
    assert.equal(await page.frame({ name: 'conteudo' }).locator('h1').innerText(), 'Cadastro de clientes');
    assert.ok(!requests.includes('/logout'));
    assert.ok(!requests.includes('/delete'));
  } finally { await page.close(); }
});

test('campos sem IDs e botão image são detectados', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/unusual');
    const form = await ui.findLogin(page);
    assert.equal(form.user.placeholder, 'Matrícula');
    assert.equal(form.button.type, 'image');
    assert.ok((await ui.login(page, credentials('/unusual'), 3000)).length);
  } finally { await page.close(); }
});

test('login aguarda formulário animado ficar realmente acionável', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/animated-login');
    assert.equal((await ui.findLogin(page)).button.selector, 'button[type="submit"]');
    const menus = await ui.login(page, credentials('/animated-login'), 4000);
    assert.ok(menus.some(entry => entry.name === 'Visão geral'));
  } finally { await page.close(); }
});

test('login usa o caminho de teclado quando o botão está coberto', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/covered-login');
    const menus = await ui.login(page, credentials('/covered-login'), 5000);
    assert.ok(menus.some(entry => entry.name === 'Visão geral'));
  } finally { await page.close(); }
});

test('menu em iframe de outra origem usa a origem do próprio frame', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<iframe src="${base}/frame-menu"></iframe>`);
    await page.locator('iframe').contentFrame().locator('nav').waitFor();
    const menus = await ui.discoverMenus(page);
    assert.ok(menus.some(entry => entry.name === 'Clientes do frame' && entry.framePath.length === 1));
  } finally { await page.close(); }
});

test('login aguarda menus carregados de forma assíncrona', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/delayed-menu-login');
    const menus = await ui.login(page, credentials('/delayed-menu-login'), 7000);
    assert.ok(menus.some(entry => entry.name === 'Módulo tardio' && !entry.virtual));
  } finally { await page.close(); }
});

test('login aguarda a árvore tardia antes de ativar o modo somente leitura', async () => {
  lateTreeRequests=0;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'documentador-late-tree-'));
  const result=await scan({credentials:credentials('/late-tree-login'),artifactsRoot:root,log(){},loginTimeoutMs:10000});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.out,'scan-manifest.json')));
  assert.equal(lateTreeRequests,1);
  assert.ok(manifest.menu.some(item=>item.name==='Cadastro tardio'));
  assert.ok(manifest.records.some(item=>item.label==='Cadastro tardio'&&item.text.includes('Cadastro tardio carregado')));
});

test('crawler integrado gera capturas e metadados de frames legados', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-crawler-'));
  const result = await scan({ credentials: credentials('/legacy'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  assert.equal(result.errors, 0);
  assert.ok(result.records >= 3);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json'), 'utf8'));
  assert.ok(manifest.records.some(e => e.text.includes('Cadastro de clientes')));
  assert.ok(manifest.records.some(e => e.kind === 'aba' && e.text.includes('Detalhes financeiros')));
  for (const record of manifest.records) assert.ok(fs.statSync(path.join(result.out, record.image)).size > 100);
});

test('crawler moderno mantém capturas sem depender de Leads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-crawler-'));
  const result = await scan({ credentials: credentials('/modern'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  assert.equal(result.errors, 0);
  assert.ok(result.records >= 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.ok(manifest.records.some(record => record.label === 'Cadastros > Clientes'));
  assert.ok(!manifest.records.some(record => record.label === 'Cadastros'));
});

test('menus Bootstrap em div navbar são descobertos sem cair em Página inicial', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-navbar-'));
  const result = await scan({ credentials: credentials('/bootstrap-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  assert.equal(result.errors, 0);
  assert.equal(result.records, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.ok(manifest.records.some(record => record.label === 'BI > Painel' && record.text.includes('Painel analítico')));
  assert.ok(manifest.records.some(record => record.label === 'Financeiro > Contas' && record.text.includes('Contas a pagar')));
  assert.ok(!manifest.records.some(record => record.label === 'Página inicial'));
});

test('menus SGE no header são descobertos antes das classes Bootstrap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-header-'));
  const result = await scan({ credentials: credentials('/header-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  assert.equal(result.errors, 0);
  assert.equal(result.records, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.ok(manifest.records.some(record => record.label === 'BI > Painel' && record.text.includes('Painel SGE')));
  assert.ok(manifest.records.some(record => record.label === 'Financeiro > Lançamentos' && record.text.includes('Lançamentos SGE')));
  assert.ok(!manifest.records.some(record => record.label === 'Página inicial'));
});

test('controle de menu usa clique de ponteiro sem disparar atalho de teclado', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<button type="button" onkeydown="window.keyboard=(window.keyboard||0)+1" onclick="window.pointer=(window.pointer||0)+1">Dashboard</button>`);
    await ui.activateMenuControl(page.locator('button'));
    assert.deepEqual(await page.evaluate(() => ({ pointer: window.pointer || 0, keyboard: window.keyboard || 0 })), { pointer: 1, keyboard: 0 });
  } finally { await page.close(); }
});

test('seletor semântico de menu sobrevive à remoção de contêiner do portal', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<div id="portal-anterior"><button type="button">Outro controle</button></div><nav><button type="button" onclick="document.querySelector('main').textContent='Dashboard aberto'">Dashboard</button></nav><main>Início</main>`);
    const dashboard = (await ui.discoverMenus(page)).find(entry => entry.name === 'Dashboard');
    assert.match(dashboard.selector, /^xpath=/);
    await page.locator('#portal-anterior').evaluate(element => element.remove());
    await ui.openMenu(page, dashboard);
    assert.equal(await page.locator('main').innerText(), 'Dashboard aberto');
  } finally { await page.close(); }
});

test('recuperação usa o histórico antes de recarregar rotas internas da SPA', async () => {
  spaLoginRequests = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-spa-recovery-'));
  const result = await scan({ credentials: credentials('/spa-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.ok(manifest.warnings.some(warning => warning.code === 'HTTP_404'));
  assert.ok(manifest.records.some(record => record.label === 'Consulta' && record.text.includes('Consulta disponível')));
  assert.equal(spaLoginRequests, 1);
});

test('retorno de Novo reutiliza o menu lateral sem recarregar a SPA autenticada', async () => {
  spaFormLoginRequests = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-spa-form-'));
  const result = await scan({ credentials: credentials('/spa-form-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.ok(manifest.records.some(record => record.label === 'Cadastros'));
  assert.ok(manifest.records.some(record => record.label === 'Cadastros > Novo cliente'));
  assert.equal(spaFormLoginRequests, 1);
});

test('erro JavaScript interno vira observação e a tela ainda é capturada sem aviso', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-script-'));
  const result = await scan({ credentials: credentials('/script-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.ok(manifest.records.some(record => record.label === 'Relatório' && record.text.includes('Tela disponível')));
  assert.equal(manifest.warnings.length, 0);
  assert.ok(manifest.notices.some(notice => notice.code === 'PAGE_SCRIPT_ERROR'));
});

test('controle sem efeito vira observação auditável sem reduzir a cobertura', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-noop-'));
  const result = await scan({ credentials: credentials('/noop-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.equal(manifest.warnings.length, 0);
  const notice = manifest.notices.find(item => item.code === 'FORM_NOT_OPENED');
  assert.ok(notice);
  assert.ok(notice.diagnostic);
});

test('campo de conta em tela autenticada não é confundido com login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-auth-field-'));
  const result = await scan({ credentials: credentials('/settings-field-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.equal(result.records, 1);
});

test('sessão expirada é autenticada novamente e a varredura continua', async () => {
  expireRequests = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-reauth-'));
  const result = await scan({ credentials: credentials('/reauth-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 4000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.ok(manifest.records.some(record => record.text.includes('Relatório após nova autenticação')));
  assert.ok(manifest.notices.some(notice => notice.message.includes('autenticando novamente')));
});

test('falha de login produz diagnóstico sem credenciais, query, fragmento ou valores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-crawler-'));
  const secret = credentials('/rejected');
  secret.SISTEMA_URL += '?token=token-privado#fragmento-privado';
  await assert.rejects(scan({ credentials: secret, artifactsRoot: root, log() {}, loginTimeoutMs: 600 }), /Login não confirmado/);
  const out = path.join(root, fs.readdirSync(root)[0]);
  const file = fs.readdirSync(out).find(f => f.startsWith('diagnostico-'));
  const data = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
  assert.equal(data.title, 'Acesso negado');
  assert.ok(data.frames[0].selectors.some(e => e.type === 'password'));
  const serialized = JSON.stringify(data);
  for (const value of [secret.SISTEMA_USER, secret.SISTEMA_PASS, 'token-privado', 'fragmento-privado']) assert.ok(!serialized.includes(value));
  assert.ok(!data.frames[0].selectors.some(e => 'value' in e));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'scan-manifest.json'))).records.length, 0);
});

test('recusa de autenticação preserva a mensagem segura do sistema no diagnóstico', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-auth-rejected-'));
  const secret = credentials('/rejected-message');
  await assert.rejects(
    scan({ credentials: secret, artifactsRoot: root, log() {}, loginTimeoutMs: 4000 }),
    /Autenticação recusada pelo sistema: Usuário ou senha inválidos\./,
  );
  const out = path.join(root, fs.readdirSync(root)[0]);
  const file = fs.readdirSync(out).find(name => name.startsWith('diagnostico-'));
  const diagnostic = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
  assert.equal(diagnostic.code, 'AUTH_REJECTED');
  assert.ok(diagnostic.interface.some(frame => frame.dialogs.some(dialog => dialog.text.includes('Usuário ou senha inválidos.'))));
  assert.ok(!JSON.stringify(diagnostic).includes(secret.SISTEMA_PASS));
});

test('diagnóstico remove segredos com aspas, escapes e codificação de URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-diagnostic-'));
  const page = await newPage();
  const secret = 'segredo-"\\@';
  try {
    await page.goto(base + '/rejected');
    await page.evaluate(value => { document.title = value; document.querySelector('input').id = value; }, secret);
    const file = await ui.writeDiagnostic(page, root, new Error(`Falha ${encodeURIComponent(secret)}\nfill ${secret}`), [secret]);
    const data = JSON.parse(fs.readFileSync(file));
    assert.equal(data.title, '[oculto]');
    assert.ok(!JSON.stringify(data).includes(JSON.stringify(secret).slice(1, -1)));
  } finally { await page.close(); }
});

test('aviso informativo com overlay é fechado e a próxima tela é capturada', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-overlay-'));
  const result = await scan({ credentials: credentials('/alert-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(manifest.records.length, 2);
  assert.ok(manifest.notices.length > 0);
  assert.ok(manifest.records.some(r => r.text.includes('Lançamento financeiro')));
  assert.ok(manifest.records.every(r => !r.text.includes('Sem dados para serem trabalhados')));
});

test('confirmação permanece intacta, recuperação continua e resultado é parcial', async () => {
  const page = await newPage();
  try {
    await page.setContent('<div role="dialog">Deseja excluir?<button onclick="window.confirmed=true">OK</button></div>');
    await assert.rejects(waitForInterface(page), /nenhuma confirmação/);
    assert.equal(await page.evaluate(() => !!window.confirmed), false);
  } finally { await page.close(); }
  await browser.close(); browser = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-recovery-'));
  const result = await scan({ credentials: credentials('/blocked-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 10000 });
  assert.equal(result.status, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.errors, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.ok(manifest.records.some(r => r.text.includes('Próxima tela')));
  const diagnostic = JSON.parse(fs.readFileSync(path.join(result.out, manifest.errors[0].diagnostic)));
  assert.equal(diagnostic.code, 'UI_DIALOG');
  assert.equal(diagnostic.action.name, 'Operacional');
  assert.ok(diagnostic.interface[0].dialogs.length);
});

test('aviso que exige seleção anterior é recuperável e não confirma nada', async () => {
  const page = await newPage();
  try {
    await page.setContent('<div role="dialog">Atenção! Escolha um convênio<button type="button" onclick="window.confirmed=true">OK</button></div>');
    await assert.rejects(waitForInterface(page), error => error.code === 'UI_PREREQUISITE' && error.recoverable === true);
    assert.equal(await page.evaluate(() => !!window.confirmed), false);
  } finally { await page.close(); }
});

test('avisos informativos dentro de iframe também são dispensados', async () => {
  const page = await newPage();
  try {
    await page.setContent('<iframe></iframe>');
    const frame = page.frames()[1];
    await frame.setContent('<div class="sweet-alert"><p>Nenhum registro encontrado</p><button type="button" onclick="this.parentElement.remove()">OK</button></div>');
    await waitForInterface(page);
    assert.equal(await frame.locator('.sweet-alert').count(), 0);
  } finally { await page.close(); }
});

test('carregamento persistente tem prazo limitado e não é removido pelo crawler', async () => {
  const page = await newPage();
  try {
    await page.setContent('<div class="blockUI blockOverlay" style="position:fixed;inset:0"></div>');
    await assert.rejects(waitForInterface(page, { timeout: 400 }), error => error.code === 'UI_BLOCKED');
    assert.equal(await page.locator('.blockOverlay').count(), 1);
  } finally { await page.close(); }
});

const menuEntries = count => Array.from({ length: count }, (_, i) => ({ name: `Módulo ${i}`, selector: `#menu${i}`, framePath: [], parentNames: [], parents: [], href: '#' }));
test('percorre mais de 150 menus e declara explicitamente um limite solicitado', async () => {
  const entries = menuEntries(175);
  const visited = [];
  const options = { discover: async () => entries, open: async () => {}, visit: async entry => visited.push(entry.name), recover: async () => {}, report: async () => {} };
  const result = await walkMenus(null, [...entries], options);
  assert.equal(result.complete, true);
  assert.equal(visited.length, 175);
  const limited = await walkMenus(null, [...entries], { ...options, maxMenus: 5 });
  assert.equal(limited.complete, false);
  assert.equal(limited.pending.length, 170);
});

test('três falhas consecutivas interrompem a cascata e preservam os menus pendentes', async () => {
  const entries = menuEntries(310);
  let errors = 0, recoveries = 0;
  const result = await walkMenus(null, entries, {
    discover: async () => entries, open: async () => { throw new Error('Bloqueado'); }, visit: async () => assert.fail(),
    recover: async () => { recoveries++; }, report: async () => { errors++; },
  });
  assert.equal(result.interrupted, true);
  assert.equal(errors, 3);
  assert.equal(recoveries, 2);
  assert.equal(result.pending.length, 307);
});

test('falhas recuperáveis do sistema são puladas sem interromper os menus seguintes', async () => {
  const entries = menuEntries(8);
  let reports = 0, recoveries = 0;
  const result = await walkMenus(null, entries, {
    discover: async () => entries,
    open: async () => { throw Object.assign(new Error('Tela indisponível'), { code: 'HTTP_404' }); },
    visit: async () => assert.fail(), recover: async () => { recoveries++; },
    report: async () => { reports++; return { recoverable: true }; },
  });
  assert.equal(result.complete, true);
  assert.equal(result.failures, 0);
  assert.equal(result.skipped, 8);
  assert.equal(result.pending.length, 0);
  assert.equal(reports, 8);
  assert.equal(recoveries, 8);
});

test('links de menus locais da tabela não viram módulos quando existe menu principal', async () => {
  const page = await newPage();
  try {
    await page.setContent('<nav><a href="#">FI</a></nav><main><div class="dropdown-menu"><a href="#">Exportar</a></div></main>');
    assert.deepEqual((await ui.discoverMenus(page)).map(e => e.name), ['FI']);
  } finally { await page.close(); }
});

test('diagnóstico de diálogo omite valores de textarea e identificadores do contêiner', async () => {
  const page = await newPage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-diagnostic-'));
  try {
    await page.setContent('<div id="identificador-privado" role="dialog"><p>Atenção</p><textarea>conteudo-privado-do-campo</textarea><button type="button">OK</button></div>');
    const file = await ui.writeDiagnostic(page, root, new Error('Diálogo bloqueado'));
    const data = fs.readFileSync(file, 'utf8');
    assert.ok(!data.includes('conteudo-privado-do-campo'));
    assert.ok(!data.includes('identificador-privado'));
  } finally { await page.close(); }
});

test('submenus profundos preservam ancestrais abertos e permitem visitar irmãos', async () => {
  const page = await newPage();
  await page.setContent(`<nav><ul><li><a href="#" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">FI</a><ul><li><a href="#" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">Tesouraria</a><ul hidden><li><a href="#" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">Competência</a><ul hidden><li><a href="#" onclick="document.querySelector('main').textContent='Abertura'">Abertura</a></li><li><a href="#" onclick="document.querySelector('main').textContent='Consulta'">Consulta</a></li></ul></li></ul></li></ul></li></ul></nav><main>Inicial</main>`);
  const entries = await ui.discoverMenus(page);
  const target = entries.find(e => e.name === 'Abertura');
  assert.deepEqual(target.parentNames, ['FI', 'Tesouraria', 'Competência']);
  await ui.openMenu(page, target);
  assert.equal(await page.locator('main').innerText(), 'Abertura');
  await ui.openMenu(page, entries.find(e => e.name === 'Consulta'));
  assert.equal(await page.locator('main').innerText(), 'Consulta');
});

test('menu JSP oculto é acionado com segurança quando o dropdown não reabre', async () => {
  const page = await newPage();
  await page.setContent(`<nav><ul><li><a href="#" onclick="this.nextElementSibling.hidden=false">Configuração</a><ul hidden><li><a href="#" onclick="this.nextElementSibling.hidden=false">Agendador</a><ul hidden><li><a href="#" onclick="void 0">FI</a><ul hidden><li><a href="javascript:window.openScreen('Atual')">Mensalidade Atual</a></li><li><a href="javascript:window.openScreen('Vencida')">Mensalidade Vencida</a></li></ul></li></ul></li></ul></li></ul></nav><main>Inicial</main><script>window.openScreen=name=>{document.querySelector('main').textContent=name;document.querySelectorAll('nav ul ul').forEach(list=>list.hidden=true)}</script>`);
  const entries = await ui.discoverMenus(page);
  await ui.openMenu(page, entries.find(entry => entry.name === 'Mensalidade Atual'));
  assert.equal(await page.locator('main').innerText(), 'Atual');
  await ui.openMenu(page, entries.find(entry => entry.name === 'Mensalidade Vencida'));
  assert.equal(await page.locator('main').innerText(), 'Vencida');
});

test('link JavaScript salvo abre tela quando o JSP remove o item do menu', async () => {
  const page = await newPage();
  await page.setContent(`<nav><ul><li><a href="#" onclick="this.nextElementSibling.hidden=false">Administrativo</a><ul hidden><li><a href="javascript:window.openScreen('Inconsistência')">Assistência 24h (Inconsistência)</a></li></ul></li></ul></nav><main>Inicial</main><script>window.openScreen=name=>document.querySelector('main').textContent=name</script>`);
  const entry = (await ui.discoverMenus(page)).find(item => item.name === 'Assistência 24h (Inconsistência)');
  await page.locator(entry.selector).evaluate(element => element.remove());
  await ui.openMenu(page, entry);
  assert.equal(await page.locator('main').innerText(), 'Inconsistência');
});

test('menu aberto por hover permite navegar sem fechar a lista', async () => {
  const page = await newPage();
  await page.setContent(`<style>li>ul{display:none}li:hover>ul{display:block}</style><nav><ul><li><a href="#">Consultas</a><ul><li><a href="#" onclick="document.querySelector('main').textContent='Clientes'">Clientes</a></li></ul></li></ul></nav><main>Inicial</main>`);
  await ui.openMenu(page, (await ui.discoverMenus(page)).find(e => e.name === 'Clientes'));
  assert.equal(await page.locator('main').innerText(), 'Clientes');
});

test('menus TinyMCE e ferramentas não viram módulos nem pais de botões irmãos', async () => {
  const page = await newPage();
  await page.setContent(`<nav><button aria-haspopup="true">FI</button><button aria-haspopup="true">Administrativo</button></nav><main><div class="mce-container"><div role="menubar"><button aria-haspopup="true">Arquivo</button><button aria-haspopup="true">Editar</button></div></div><div class="tox"><button role="menuitem">Visualizar</button></div><div role="toolbar"><button role="menuitem">Inserir</button></div></main>`);
  const menus = await ui.discoverMenus(page);
  assert.deepEqual(menus.map(e => e.name), ['FI', 'Administrativo']);
  assert.ok(menus.every(e => e.parents.length === 0));
  await page.locator('nav').evaluate(el => el.remove());
  assert.deepEqual((await ui.discoverMenus(page)).map(item => item.name), ['Página inicial']);
});

test('fila reencontra menu após mudança de seletor e preserva nomes repetidos em outros módulos', async () => {
  const initial = ['FI', 'Administrativo'].map((parent, index) => ({ ...menuEntries(1)[0], name: 'Consulta', parentNames: [parent], parents: [`#old-parent${index}`], selector: `#old${index}` }));
  const updated = initial.map((entry, index) => ({ ...entry, parents: [`#new-parent${index}`], selector: `#new${index}` }));
  const visited = [];
  const result = await walkMenus(null, [...initial], {
    discover: async () => updated, open: async e => { assert.ok(e.selector.startsWith('#new')); assert.ok(e.parents[0].startsWith('#new-parent')); },
    visit: async e => visited.push(e.parentNames[0]), recover: async () => assert.fail(), report: async () => assert.fail(),
  });
  assert.equal(result.complete, true);
  assert.equal(result.attempted, 2);
  assert.deepEqual(visited, ['FI', 'Administrativo']);
});

test('descoberta de submenus não depende do nome do módulo', async () => {
  const root = { name: 'Terceiros', selector: '#root', href: '#', framePath: [], parents: [], parentNames: [] };
  const child = { name: 'Operadoras', selector: '#child', href: '#', framePath: [], parents: [], parentNames: [] };
  let expanded = false;
  const queue = [root];
  const result = await walkMenus(null, queue, {
    discover: async () => expanded ? [root, child] : [root],
    open: async entry => { if (entry.name === root.name) expanded = true; },
    visit: async () => {}, recover: async () => {}, report: async () => ({ recoverable: false }),
  });
  assert.equal(result.failures, 0);
  assert.deepEqual(queue.map(entry => entry.name), ['Terceiros', 'Operadoras']);
  assert.deepEqual(queue[1].parentNames, ['Terceiros']);
});

test('submenus homônimos em ramos diferentes do mesmo módulo são preservados', async () => {
  const root={name:'Administrativo',selector:'#root',href:'#',framePath:[],parents:[],parentNames:[]};
  const first={name:'Consulta',selector:'#first',href:'#first',framePath:[],parents:['#root','#cadastros'],parentNames:['Administrativo','Cadastros']};
  const second={name:'Consulta',selector:'#second',href:'#second',framePath:[],parents:['#root','#relatorios'],parentNames:['Administrativo','Relatórios']};
  const queue=[root];let expanded=false;const visited=[];
  await walkMenus(null,queue,{
    discover:async()=>expanded?[root,first,second]:[root],open:async entry=>{if(entry.name===root.name)expanded=true},
    visit:async entry=>visited.push((entry.parentNames||[]).join(' > ')),recover:async()=>{},report:async()=>({recoverable:false}),
  });
  assert.equal(queue.length,3);
  assert.deepEqual(visited,['Administrativo > Cadastros','Administrativo > Relatórios']);
});

test('submenus homônimos exibidos sequencialmente em portais são preservados por caminho', async () => {
  const first={name:'Módulo A',selector:'#a',href:'#',framePath:[],parents:[],parentNames:[]};
  const second={name:'Módulo B',selector:'#b',href:'#',framePath:[],parents:[],parentNames:[]};
  const child={name:'Consulta',selector:'#consulta',href:'#consulta',framePath:[],parents:[],parentNames:[]};
  let active='';const queue=[first,second];
  await walkMenus(null,queue,{
    discover:async()=>[first,second],discoverAfterOpen:async()=>/^Módulo/.test(active)?[first,second,child]:[first,second],
    open:async entry=>{active=entry.name},visit:async()=>{},recover:async()=>{},report:async()=>({recoverable:false}),
  });
  assert.deepEqual(queue.filter(item=>item.name==='Consulta').map(item=>item.parentNames),[['Módulo A'],['Módulo B']]);
});

test('módulo com página própria é capturado antes dos seus submódulos', async () => {
  const root={name:'Administrativo',selector:'#root',href:'#',framePath:[],parents:[],parentNames:[]};
  const child={name:'Associados',selector:'#child',href:'#child',framePath:[],parents:['#root'],parentNames:['Administrativo']};
  const queue=[root];let expanded=false;const visited=[];
  await walkMenus(null,queue,{
    discover:async()=>expanded?[root,child]:[root],
    open:async entry=>{if(entry.name===root.name)expanded=true;return {changed:true}},
    visit:async entry=>visited.push([...(entry.parentNames||[]),entry.name].join(' > ')),recover:async()=>{},report:async()=>({recoverable:false}),
  });
  assert.deepEqual(visited,['Administrativo','Administrativo > Associados']);
});

test('detecta abas JSP por stepper, fragmento, aria-controls e título em ícone', async () => {
  const page=await newPage();
  await page.setContent(`<main><div class="steps"><a href="#dados" title="Dados gerais"><i></i></a><button type="button" aria-controls="documentos">Documentos</button><div onclick="document.querySelector('h2').textContent='Resumo'" title="Resumo"></div></div><section id="dados"></section><section id="documentos"></section><h2>Inicial</h2></main>`);
  const tabs=await contentControls(page,'tab');
  assert.deepEqual(tabs.map(item=>item.name),['Dados gerais','Documentos','Resumo']);
});

test('não confunde paginação Próximo e Anterior com abas', async () => {
  const page=await newPage();
  await page.setContent(`<main><div class="pagination"><button id="btn-anterior">Anterior</button><button id="btn-anterior">Anterior</button><button>Próximo</button></div><div class="nav-tabs"><button role="tab">Dados</button></div></main>`);
  const tabs=await contentControls(page,'tab');
  assert.deepEqual(tabs.map(item=>item.name),['Dados']);
  assert.ok(!tabs.some(item=>item.selector==='#btn-anterior'));
});

test('IDs duplicados recebem seletores estruturais e não causam strict mode', async () => {
  const page=await newPage();
  await page.setContent(`<main><div class="nav-tabs"><button id="aba" role="tab" onclick="document.querySelector('h2').textContent='Primeira'">Primeira</button><button id="aba" role="tab" onclick="document.querySelector('h2').textContent='Segunda'">Segunda</button></div><h2>Inicial</h2></main>`);
  const tabs=await contentControls(page,'tab');
  assert.equal(tabs.length,2);
  assert.ok(tabs.every(item=>item.selector!=='#aba'));
  const captures=[];
  await exploreContent(page,['Ficha'],{capture:async labels=>captures.push(labels.join(' > ')),report:async(_label,error)=>{throw error},restore:async()=>{}});
  assert.deepEqual(captures,['Ficha > Primeira','Ficha > Segunda']);
});

test('imagem branca é reconhecida e a captura aguarda o conteúdo renderizado', async () => {
  const white=jpeg.encode({data:Buffer.alloc(100*100*4,255),width:100,height:100},84).data;
  assert.equal(analyzeJpeg(white).blank,true);
  const page=await newPage();
  await page.setContent(`<div class="spinner" style="width:30px;height:30px;border:6px solid #eee;border-top-color:#d55;border-radius:50%"></div><script>setTimeout(()=>document.body.innerHTML='<main><h1>Ficha pronta</h1><input name=nome></main>',500)</script>`);
  const started=Date.now();
  const result=await takeUsableScreenshot(page,{timeout:3000,interval:100});
  assert.ok(Date.now()-started>=400);
  assert.equal(await page.locator('h1').innerText(),'Ficha pronta');
  assert.ok(result.bytes.length>0);
});

test('carregador branco obsoleto é ocultado só durante a exploração e depois restaurado', async () => {
  const page=await newPage();
  await page.setContent(`<main style="min-height:700px;background:#174ea6;color:white"><h1>Novo cadastro</h1><form><label>Nome<input name="nome"></label><button type="button">Dados adicionais</button></form></main><div class="loading-overlay" style="position:fixed;inset:0;background:white;z-index:100"><div class="spinner"></div></div>`);
  const result=await takeUsableScreenshot(page,{timeout:3000,interval:50,staleLoaderMs:100});
  assert.equal(result.recoveredLoading,true);
  assert.equal(await page.locator('.loading-overlay').evaluate(element=>getComputedStyle(element).visibility),'hidden');
  assert.equal(analyzeJpeg(result.bytes).blank,false);
  await restoreSuppressedLoading(page);
  assert.equal(await page.locator('.loading-overlay').evaluate(element=>getComputedStyle(element).visibility),'visible');
});

test('página virtual de uma rota final não entra novamente na fila de menus', async () => {
  const entry = menuEntries(1)[0];
  const virtual = { ...entry, name: 'Página inicial', selector: 'body', virtual: true };
  let discoveries = 0, visits = 0;
  const result = await walkMenus(null, [entry], {
    discover: async () => ++discoveries === 1 ? [entry] : [virtual],
    open: async () => {}, visit: async () => visits++, recover: async () => assert.fail(), report: async () => assert.fail(),
  });
  assert.equal(result.complete, true);
  assert.equal(result.attempted, 1);
  assert.equal(visits, 1);
});

test('carregamento transitório é recuperado uma vez antes de capturar', async () => {
  const entries = menuEntries(1);
  let opens = 0, recoveries = 0, retries = 0, captures = 0;
  const result = await walkMenus(null, [...entries], {
    discover: async () => entries,
    open: async () => { if (++opens === 1) throw Object.assign(new Error('Carregando'), { code: 'UI_BLOCKED' }); },
    visit: async () => captures++, recover: async () => recoveries++, onRetry: () => retries++, report: async () => assert.fail(),
  });
  assert.equal(result.complete, true);
  assert.deepEqual([opens, recoveries, retries, captures], [2, 1, 1, 1]);
});

test('falha persistente tem duas tentativas por menu e mantém o limite de três falhas', async () => {
  const entries = menuEntries(10);
  let opens = 0, retries = 0, reports = 0;
  const result = await walkMenus(null, entries, {
    discover: async () => entries,
    open: async () => { opens++; throw Object.assign(new Error('Oculto'), { code: 'MENU_HIDDEN' }); },
    visit: async () => assert.fail(), recover: async () => {}, onRetry: () => retries++, report: async () => reports++,
  });
  assert.deepEqual([opens, retries, reports], [6, 3, 3]);
  assert.equal(result.interrupted, true);
  assert.equal(result.pending.length, 7);
});

test('login com usuário e senha em etapas é detectado automaticamente', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/two-step');
    const firstStep = await ui.findLogin(page);
    assert.equal(firstStep.user.selector, '#account');
    assert.equal(firstStep.password, null);
    const menus = await ui.login(page, credentials('/two-step'), 5000);
    assert.deepEqual(menus.map(item => item.name), ['Página inicial']);
    assert.match(await page.locator('main').innerText(), /duas etapas concluído/);
  } finally { await page.close(); }
});

test('página sem menu é capturada e links internos, formulários e abas são explorados', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-single-'));
  const result = await scan({ credentials: credentials('/single-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.errors, 0);
  assert.equal(result.status, 'complete');
  assert.ok(manifest.records.some(record => record.label === 'Página inicial' && record.kind === 'geral'));
  assert.ok(manifest.records.some(record => record.label === 'Página inicial > Detalhes da conta' && record.kind === 'tela'));
  assert.ok(manifest.records.some(record => record.label.includes('Adicionar contato') && record.kind === 'novo'));
  assert.ok(manifest.records.some(record => record.label.endsWith('Endereço') && record.kind === 'aba'));
});

test('abre Novo e Criar uma nova em JSP sem main, captura abas e não salva nem exclui', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-forms-'));
  const start = requests.length;
  const result = await scan({ credentials: credentials('/forms-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.errors, 0);
  assert.equal(result.status, 'complete');
  assert.equal(manifest.records.filter(record => record.kind === 'novo').length, 2);
  assert.ok(manifest.records.some(record => record.label.includes('Novo cliente > Endereço')));
  assert.ok(manifest.records.some(record => record.label.includes('Criar uma nova proposta > Endereço')));
  assert.ok(!requests.slice(start).some(route => route.startsWith('/forbidden-')));
});

test('aguarda o formulário deixar a tela branca de carregamento antes da captura', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'documentador-delayed-form-'));
  const result=await scan({credentials:credentials('/delayed-form-login'),artifactsRoot:root,log(){},loginTimeoutMs:5000,captureTimeoutMs:5000});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.out,'scan-manifest.json')));
  const form=manifest.records.find(record=>record.kind==='novo');
  assert.ok(form);
  assert.match(form.text,/Novo cliente carregado/);
  assert.equal(manifest.records.some(record=>record.duplicateOf),false);
});

test('remove carregamento branco obsoleto, captura o formulário e percorre suas abas', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'documentador-stale-form-'));
  const result=await scan({credentials:credentials('/stale-form-login'),artifactsRoot:root,log(){},loginTimeoutMs:5000,captureTimeoutMs:5000,staleLoaderMs:100});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.out,'scan-manifest.json')));
  assert.equal(result.errors,0);
  assert.equal(result.status,'complete');
  assert.ok(manifest.records.some(record=>record.kind==='novo'&&record.text.includes('Novo cliente pronto')));
  assert.ok(manifest.records.some(record=>record.kind==='aba'&&record.label.endsWith('Endereço')));
  assert.ok(manifest.notices.some(item=>item.message.includes('Camada de carregamento obsoleta')));
  assert.ok(!requests.some(route=>route.includes('forbidden-save')));
});

test('aguarda o destino real depois de uma navegação intermediária para loader', async () => {
  assert.equal(transientLoaderNavigation(base + '/img/loader_base.svg'), true);
  assert.equal(transientLoaderNavigation(base + '/cadastro/novo.jsp'), false);
  const page = await newPage();
  await page.goto(base + '/loader-navigation-home');
  const captures = [];
  await exploreContent(page, ['Clientes'], {
    capture: async (labels, kind, target) => captures.push({ labels, kind, url: target.url(), text: await target.locator('body').innerText() }),
    report: async (_label, error) => { throw error; },
    restore: async () => {},
  });
  const form = captures.find(item => item.kind === 'novo');
  assert.ok(form);
  assert.match(form.url, /loader-navigation-form$/);
  assert.match(form.text, /Novo cliente carregado após o loader/);
  assert.ok(requests.includes('/img/loader_base.svg'));
});

test('navegador visível usa a janela real maximizada e Chrome por padrão', async () => {
  const launch = browserLaunchOptions({ headless: false });
  const context = browserContextOptions({ headless: false });
  assert.equal(launch.channel, 'chrome');
  assert.equal(launch.headless, false);
  assert.ok(launch.args.includes('--start-maximized'));
  assert.ok(!launch.args.some(argument => argument.includes('-32000')));
  assert.equal(context.viewport, null);
  const calls = [];
  const session = {
    async send(method, params) { calls.push({ method, params }); return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {}; },
    async detach() { calls.push({ method: 'detach' }); },
  };
  await maximizePageWindow({ context: () => ({ newCDPSession: async () => session }) });
  assert.deepEqual(calls, [
    { method: 'Browser.getWindowForTarget', params: undefined },
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'maximized' } } },
    { method: 'detach' },
  ]);
});

test('descobre Novo em iframe e não trata botões submit ou Salvar como abertura', async () => {
  const page = await newPage();
  await page.setContent('<iframe></iframe>');
  const frame = page.frames()[1];
  const initial = `<header><input type="button" value="Nova ficha" onclick="document.body.innerHTML='<div role=dialog><form><input><button>Salvar</button></form></div>'"></header><form><button type="submit">Novo registro</button></form><button>Salvar</button><button>Deletar</button>`;
  await frame.setContent(initial);
  assert.deepEqual((await contentControls(page, 'new')).map(item => item.name), ['Nova ficha']);
  const captures = [];
  await exploreContent(page, ['Clientes'], {
    capture: async (labels, kind) => captures.push({ labels, kind }), report: async (_label, error) => { throw error; },
    restore: async () => frame.setContent(initial),
  });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].kind, 'novo');
  assert.equal(await frame.locator('[role=dialog]').count(), 0);
});

test('404 de XHR auxiliar não vira aviso e permanece auditável no diagnóstico', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-http-'));
  const start = requests.length;
  const result = await scan({ credentials: credentials('/http-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000, interfaceTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(result.status, 'complete');
  assert.equal(result.errors, 0);
  assert.ok(requests.slice(start).filter(route => route === '/missing.jsp').length >= 1);
  assert.ok(manifest.records.some(record => record.text.includes('Consulta disponível')));
  assert.equal(manifest.warnings.length, 0);
  const notice = manifest.notices.find(item => item.code === 'SCREEN_NOT_OPENED');
  const diagnostic = JSON.parse(fs.readFileSync(path.join(result.out, notice.diagnostic)));
  assert.equal(diagnostic.code, 'SCREEN_NOT_OPENED');
  assert.equal(diagnostic.network[0].status, 404);
  assert.ok(!JSON.stringify(diagnostic).includes('nao-registrar'));
});

test('modo somente leitura permite POST neutro da navegação e bloqueia ações perigosas', async () => {
  readPosts = 0;
  const start = requests.length;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documentador-post-read-'));
  const result = await scan({ credentials: credentials('/post-read-login'), artifactsRoot: root, log() {}, loginTimeoutMs: 5000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, 'scan-manifest.json')));
  assert.equal(readPosts, 1);
  assert.equal(result.errors, 0);
  assert.ok(manifest.records.some(record => record.text.includes('Tela consultada por POST')));
  assert.ok(!manifest.records.some(record => record.text.includes('Não deveria abrir')));
  assert.ok(!requests.slice(start).some(route => route === '/save-record'));
});

test('menu sem transição não recebe uma captura com o nome de outra tela', async () => {
  const queue=[{name:'Tela sem efeito',selector:'#noop',href:'#',id:'noop',parents:[],parentNames:[],framePath:[]}];
  const reports=[];
  const result=await walkMenus({},queue,{
    discover:async()=>queue,
    open:async()=>({changed:false}),
    visit:async()=>assert.fail('a tela sem transição não pode ser capturada'),
    report:async(label,error)=>{reports.push({label,code:error.code});return {recoverable:true}},
    recover:async()=>{},
  });
  assert.equal(result.visited,0);
  assert.equal(result.skipped,1);
  assert.deepEqual(reports,[{label:'Tela sem efeito',code:'SCREEN_NOT_OPENED'}]);
});

test('monitor ignora credenciais de login e descarta erros da ação anterior', async () => {
  const page = await newPage();
  await page.goto(base + '/modern');
  const warnings = [];
  const network = attachNetworkMonitor(page, url => ui.safeUrl(url, ui.redactor([])), warning => warnings.push(warning));
  await page.evaluate(() => fetch('/missing.jsp?senha=privada'));
  assert.deepEqual(network.snapshot(), []);
  network.reset();
  await page.evaluate(() => fetch('/missing.jsp?token=privado'));
  assert.equal(network.failure().code, 'HTTP_404');
  assert.equal(network.failure({ documentOnly: true }), null);
  assert.ok(!JSON.stringify(network.snapshot()).includes('privado'));
  network.reset();
  assert.equal(network.failure(), null);
  network.reset('Tela de teste');
  await page.evaluate(() => setTimeout(() => { throw new TypeError('falha interna'); }, 0));
  await page.waitForTimeout(50);
  assert.equal(network.failure(), null);
  assert.match(warnings[0], /Tela de teste.*TypeError/);
  network.dispose();
});

test('Novo sem efeito vira aviso recuperável e não é registrado como formulário capturado', async () => {
  const page = await newPage();
  await page.setContent('<button type="button">Novo</button>');
  const failures = [];
  await exploreContent(page, ['Clientes'], {
    capture: async () => assert.fail('Não há formulário para capturar'),
    report: async (_label, error) => failures.push({ code: error.code, recoverable: error.recoverable }), restore: async () => {},
  });
  assert.deepEqual(failures, [{ code: 'FORM_NOT_OPENED', recoverable: true }]);
});

test('abas e botões atrás de uma janela modal não são explorados', async () => {
  const page = await newPage();
  await page.setContent('<button role="tab">Aba da lista</button><button type="button">Novo na lista</button><div role="dialog" style="position:fixed;inset:0;background:white;z-index:10"><input><button role="tab" type="button">Dados da ficha</button><button type="button">Salvar</button></div>');
  assert.deepEqual((await contentControls(page, 'tab')).map(item => item.name), ['Dados da ficha']);
  assert.deepEqual(await contentControls(page, 'new'), []);
});
