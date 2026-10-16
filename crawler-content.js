const ui = require('./crawler-interface');
const { waitForInterface } = require('./crawler-ui-state');

const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const opening = /^(?:nov[oa](?:\s|$)|criar (?:um |uma )?nov[oa](?:\s|$)|adicionar(?:\s|$)|cadastrar(?:\s|$)|incluir(?:\s|$)|novo cadastro(?:\s|$))/;
const dangerous = /\b(salvar|gravar|excluir|deletar|remover|enviar|submeter|confirmar|finalizar|publicar|pagar|aprovar|reprovar|bloquear|desativar|inativar)\b/;

async function signature(page) {
  const data = [];
  for (const frame of page.frames()) data.push(await frame.evaluate(() => ({
    url: location.href.split('#')[0], text: document.body?.innerText || '',
    fields: [...document.querySelectorAll('input,select,textarea,[role="dialog"]')].filter(el => el.getClientRects().length)
      .map(el => [el.tagName, el.getAttribute('type'), el.getAttribute('name')]),
  })).catch(() => null));
  // Keep only a digest in memory; never persist field values or this DOM data.
  return require('node:crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function controls(page, kind) {
  const result = [];
  for (const frame of page.frames()) {
    const items = await frame.locator('button,a,input[type="button"],input[type="submit"],[role="button"],[role="tab"]').evaluateAll(elements => {
      const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const activeDialog = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],.modal')].filter(visible)
        .sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0)).at(-1);
      const selector = el => {
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        for (let node = el; node?.nodeType === 1; node = node.parentElement) {
          const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.tagName === node.tagName) : [node];
          parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
          if (node.tagName === 'BODY') break;
        }
        return parts.join(' > ');
      };
      return elements.filter(el => visible(el) && (!activeDialog || activeDialog.contains(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
        .map(el => ({
          selector: selector(el),
          // Only static button captions; never read text/password input values.
          name: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.tagName === 'INPUT' ? el.getAttribute('value') : el.innerText) || '').trim(),
          submit: !!el.form && ['submit', 'image'].includes(el.type),
          navigation: !!el.closest('nav,aside,[role="navigation"],.sidebar'),
          editor: !!el.closest('.tox,.mce-container,.cke,.ck-editor,[contenteditable="true"]'),
          tab: el.matches('[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"],.nav-tabs a,.nav-pills a'),
          selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') || el.parentElement?.classList.contains('active'),
          href: el.getAttribute('href') || '',
          screen: !el.closest('nav,aside,header,[role="navigation"],form,table,[role="dialog"],[role="alertdialog"],.modal,.dropdown-menu,.pagination')
            && !el.matches('[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"],.nav-tabs a,.nav-pills a')
            && !!el.closest('main,[role="main"],#content,#conteudo,.content')
            && (el.getAttribute('role') === 'link' || (el.matches('a[href]') && !/^(#|javascript:|mailto:|tel:)/i.test(el.getAttribute('href'))
              && (() => { try { return new URL(el.href).origin === location.origin; } catch { return false; } })())),
        }));
    }).catch(() => []);
    const indices = [];
    for (let f = frame; f.parentFrame(); f = f.parentFrame()) indices.unshift(f.parentFrame().childFrames().indexOf(f));
    const counts = new Map();
    for (const item of items) {
      const name = normalize(item.name);
      if (!name || item.submit || item.editor || dangerous.test(name)) continue;
      if (kind === 'new' && (!opening.test(name) || item.navigation)) continue;
      if (kind === 'tab' && !item.tab) continue;
      if (kind === 'screen' && (!item.screen || opening.test(name))) continue;
      const occurrence = counts.get(name) || 0;
      counts.set(name, occurrence + 1);
      result.push({ ...item, name: item.name.replace(/\s+/g, ' '), framePath: indices, occurrence, kind });
    }
  }
  return result;
}

async function activate(page, descriptor) {
  const found = (await controls(page, descriptor.kind)).find(item => normalize(item.name) === normalize(descriptor.name)
    && item.occurrence === descriptor.occurrence && JSON.stringify(item.framePath) === JSON.stringify(descriptor.framePath));
  if (!found) throw new Error(`Controle de navegação não reencontrado: ${descriptor.name}`);
  const locator = ui.resolveFrame(page, found.framePath).locator(found.selector);
  await ui.activateMenuControl(locator);
}

async function openLinkedPage(page, descriptor) {
  const found = (await controls(page, descriptor.kind)).find(item => normalize(item.name) === normalize(descriptor.name)
    && item.occurrence === descriptor.occurrence && JSON.stringify(item.framePath) === JSON.stringify(descriptor.framePath));
  if (!found || !found.href || /^(#|javascript:|mailto:|tel:)/i.test(found.href)) return null;
  const frame = ui.resolveFrame(page, found.framePath);
  const url = new URL(found.href, frame.url()).href;
  const linked = await page.context().newPage();
  linked.setDefaultTimeout(5000);
  linked.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  try {
    const response = await linked.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) throw Object.assign(new Error(`O servidor retornou HTTP ${response.status()} ao abrir ${url}.`), { code: `HTTP_${response.status()}` });
    return linked;
  } catch (error) {
    await linked.close().catch(() => {});
    throw error;
  }
}

async function activateForm(page, descriptor) {
  const linked = await openLinkedPage(page, descriptor);
  if (linked) return linked;
  let navigation = null;
  let popup = null;
  const context = page.context();
  const onPage = candidate => { if (candidate !== page) popup = candidate; };
  const intercept = async route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.url().split('#')[0] !== page.url().split('#')[0]) {
      navigation = { url: request.url(), method: request.method().toUpperCase() };
      return route.abort();
    }
    return route.fallback();
  };
  context.on('page', onPage);
  await page.route('**/*', intercept);
  try {
    await activate(page, descriptor).catch(error => { if (!navigation) throw error; });
    for(let attempt=0;attempt<15&&!navigation&&!popup;attempt++)await page.waitForTimeout(100);
  } finally {
    await page.unroute('**/*', intercept);
    context.off('page', onPage);
  }
  if (popup) { await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}); return popup; }
  if (!navigation) return page;
  if (navigation.method !== 'GET') throw Object.assign(new Error('A tela nova exige o reenvio de dados; a navegação foi bloqueada pelo modo somente leitura.'), { code: 'FORM_NAVIGATION_BLOCKED', recoverable: true });
  const isolated = await page.context().newPage();
  isolated.setDefaultTimeout(5000);
  isolated.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  try {
    const response = await isolated.goto(navigation.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) throw Object.assign(new Error(`O servidor retornou HTTP ${response.status()} ao abrir ${navigation.url}.`), { code: `HTTP_${response.status()}` });
    return isolated;
  } catch (error) {
    await isolated.close().catch(() => {});
    throw error;
  }
}

async function exploreContent(page, parts, { capture, report, restore, interfaceOptions = {}, onAction = () => {}, isKnownScreen = () => false }) {
  const waitOn = target => waitForInterface(target, { ...interfaceOptions, failureCheck:target===page?interfaceOptions.failureCheck:undefined, allowForms: true })
    .catch(error=>{if(!(interfaceOptions.allowBlocked&&error.code==='UI_BLOCKED'))throw error});
  const wait = () => waitOn(page);
  const restoreRoute = async route => {
    await restore();
    const restored = [];
    for (const tab of route) { restored.push(tab.name); onAction(restored.join(' > ')); await activate(page, tab); await wait(); }
  };
  // Read every visible tab, including JSP/Bootstrap tabs without role="tab".
  async function tabs(labels, route, ancestors = new Set(), depth = 0, allowNew = true, currentPage = page) {
    const items = await controls(currentPage, 'tab');
    const key = item => JSON.stringify([item.framePath, normalize(item.name), item.occurrence]);
    const siblings = new Set([...ancestors, ...items.map(key)]);
    for (const tab of items) {
      if (ancestors.has(key(tab))) continue;
      try {
        onAction([...labels, tab.name].join(' > '));
        await activate(currentPage, tab);
        await waitOn(currentPage);
        await capture([...labels, tab.name], 'aba', currentPage);
        const nextRoute = [...route, tab];
        if (allowNew) await forms([...labels, tab.name], nextRoute);
        if (depth < 3) await tabs([...labels, tab.name], nextRoute, siblings, depth + 1, allowNew, currentPage);
        else if ((await controls(currentPage, 'tab')).some(item => !siblings.has(key(item)))) throw new Error('Há abas adicionais além do limite de profundidade; cobertura incompleta.');
      } catch (error) {
        if (!allowNew) throw error;
        await report([...labels, tab.name].join(' > '), error);
        await restoreRoute(route);
      }
    }
  }
  async function forms(labels, route) {
    const openers = await controls(page, 'new');
    for (const opener of openers) {
      let formPage=page;
      try {
        const before = await signature(page);
        onAction([...labels, opener.name].join(' > '));
        formPage=await activateForm(page,opener);
        await waitOn(formPage);
        const deadline = Date.now() + 5000;
        while ((await signature(formPage)) === before) {
          if (Date.now() >= deadline) throw Object.assign(new Error('O botão foi acionado, mas nenhum formulário ou tela nova foi aberto.'), { code: 'FORM_NOT_OPENED' });
          await formPage.waitForTimeout(150);
          await waitOn(formPage);
        }
        await capture([...labels, opener.name], 'novo', formPage);
        await tabs([...labels, opener.name], [], new Set(), 0, false, formPage);
      } catch (error) { await report([...labels, opener.name].join(' > '), error); }
      // Reload the original list in the same session instead of submitting or
      // relying on Escape, which many JSP forms do not handle.
      finally {
        if(formPage!==page)await formPage.close().catch(()=>{});
        else await restoreRoute(route);
      }
    }
  }
  async function screens(labels, route, visited = new Set(), depth = 0) {
    const items = (await controls(page, 'screen')).filter(item=>!isKnownScreen(item.name));
    for (const screen of items) {
      const key = JSON.stringify([screen.framePath, normalize(screen.name), screen.href]);
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        onAction([...labels, screen.name].join(' > '));
        await activate(page, screen);
        await wait();
        await capture([...labels, screen.name], 'tela');
        const nextRoute = [...route, screen];
        await forms([...labels, screen.name], nextRoute);
        await tabs([...labels, screen.name], nextRoute);
        if (depth < 4) await screens([...labels, screen.name], nextRoute, visited, depth + 1);
        else if ((await controls(page, 'screen')).some(item => !visited.has(JSON.stringify([item.framePath, normalize(item.name), item.href])))) {
          throw Object.assign(new Error('Há telas internas além do limite seguro de profundidade.'), { code: 'SCREEN_DEPTH_LIMIT' });
        }
      } catch (error) { await report([...labels, screen.name].join(' > '), error); }
      finally { await restoreRoute(route); }
    }
  }
  await forms(parts, []);
  await tabs(parts, []);
  await screens(parts, []);
}

module.exports = { exploreContent, controls, activate };
