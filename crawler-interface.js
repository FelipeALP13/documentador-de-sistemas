const fs = require('node:fs');
const path = require('node:path');
const { waitForInterface, diagnosticState } = require('./crawler-ui-state');
const { networkDiagnostics } = require('./crawler-network');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const authenticatedMenuSettleMs = 5000;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const unsafe = /(?:^|\b)(sair|logout|logoff|excluir|exclusao|deletar|delete|remover|salvar|gravar|enviar|submeter|publicar|pagar|confirmar|cancelar|encerrar|aprovar|reprovar|bloquear|desativar|inativar)(?:\b|$)/i;
const controls = 'input,button,a,select,[role="button"],[role="link"],[role="menuitem"],[onclick]';

// Only structural metadata: never read input values, HTML, cookies or storage.
async function inspect(frame) {
  return frame.locator(controls).evaluateAll(elements => {
    const selector = el => {
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName.toLowerCase();
      const unique = candidate => {
        try { return document.querySelectorAll(candidate).length === 1 ? candidate : null; }
        catch { return null; }
      };
      // Prefer selectors that survive portal transitions and sibling removal.
      // Positional paths are retained only when no unique structural attribute
      // exists, which is common for repeated navigation items.
      for (const attribute of ['name', 'aria-label', 'autocomplete', 'type', 'href']) {
        const value = el.getAttribute(attribute);
        if (!value) continue;
        const candidate = unique(`${tag}[${attribute}="${CSS.escape(value)}"]`);
        if (candidate) return candidate;
      }
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !(text.includes('"') && text.includes("'"))) {
        const literal = text.includes('"') ? `'${text}'` : `"${text}"`;
        const xpath = `//${tag}[normalize-space(.)=${literal}]`;
        try {
          if (document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) return `xpath=${xpath}`;
        } catch {}
      }
      const parts = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.tagName === node.tagName) : [node];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        if (tag === 'body') break;
      }
      return parts.join(' > ');
    };
    return elements.map(el => ({
      selector: selector(el), tag: el.tagName.toLowerCase(), type: (el.type || el.getAttribute('type') || '').toLowerCase(), role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '', id: el.id || '', autocomplete: el.getAttribute('autocomplete') || '',
      label: [...(el.labels || [])].map(e => e.textContent.trim()).join(' '),
      text: (el.tagName === 'INPUT' ? el.getAttribute('alt') || '' : el.textContent || '').trim().slice(0, 160),
      aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '',
      visible: !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden', disabled: !!el.disabled,
      form: el.form ? selector(el.form) : null, href: el.getAttribute('href') || '',
      expanded: el.getAttribute('aria-expanded'),
      navigation: !!el.closest('nav,header,[role="navigation"],[role="menu"],[role="menubar"],[id*="menu" i],[class*="menu" i],[id*="nav" i],[class~="nav" i],[class*="navbar" i],[class*="navigation" i]'),
      primaryNavigation: !!el.closest('nav,header,aside,[role="navigation"],[id*="nav" i],[class~="nav" i],[class*="navbar" i],[class*="navigation" i],[class*="sidebar" i]'),
      editorControl: !!el.closest('.tox,.tox-tinymce,.mce-container,.mce-tinymce,.cke,.ck-editor,[role="toolbar"],[contenteditable="true"]'),
      contentNavigation: !!el.closest('main,[role="main"],#content,#conteudo,.content')
        && !el.closest('form,table,[role="dialog"],[role="alertdialog"],.modal,.dropdown-menu,.pagination,.tox,.mce-container,.cke,.ck-editor'),
      parents: (() => {
        const result = [];
        for (let p = el.parentElement; p && p.tagName !== 'BODY'; p = p.parentElement) {
          const branch = [...p.children].find(child => child !== el && child.contains(el));
          if (!branch) continue; // Sibling menu buttons are peers, never parents.
          const trigger = [...p.children].find(c => c !== el && c.matches('a,button,[role="menuitem"]')
            && (c.hasAttribute('aria-expanded') || c.hasAttribute('aria-haspopup') || p.matches('li,.grupo')
              || [...p.children].some(child => child !== el && child.contains(el) && child.matches('ul,[role="menu"]'))));
          if (trigger && !trigger.contains(el)) result.unshift(selector(trigger));
        }
        return result;
      })(),
    }));
  });
}

function framePath(frame) {
  const indices = [];
  for (let f = frame; f.parentFrame(); f = f.parentFrame()) indices.unshift(f.parentFrame().childFrames().indexOf(f));
  return indices;
}
function resolveFrame(page, indices) {
  let frame = page.mainFrame();
  for (const index of indices) frame = frame?.childFrames()[index];
  return frame;
}

async function findLogin(page, { strict = false } = {}) {
  for (const frame of page.frames()) {
    const items = await inspect(frame).catch(() => []);
    const passwords = items.filter(e => e.visible && !e.disabled && e.type.toLowerCase() === 'password');
    const userScore = e => /username|usuario|user|login|email|e-mail|utilizador|matricula|identificacao|account|conta/.test(normalize(`${e.id} ${e.name} ${e.label} ${e.aria} ${e.placeholder} ${e.autocomplete}`)) ? 20 : 0;
    const inputs = items.filter(e => e.visible && !e.disabled && e.tag === 'input'
      && ['', 'text', 'email', 'tel', 'number'].includes(e.type.toLowerCase())).sort((a, b) => userScore(b) - userScore(a));
    const password = passwords[0] || null;
    const user = inputs.filter(e => !password || e.form === password.form).sort((a, b) => userScore(b) - userScore(a))[0]
      || (password ? null : inputs.find(e => userScore(e) > 0));
    if (!password && (!user || !userScore(user))) continue;
    const form = password?.form || user?.form;
    const buttons = items.filter(e => e.visible && !e.disabled && (e.form === form || !e.form)
      && (e.tag === 'button' || e.tag === 'a' || ['submit', 'button', 'image'].includes(e.type)));
    const buttonScore = e => (/entrar|acessar|login|logar|conectar|entrad|sign.?in|autenticar|acesso|continuar|continue|proximo|next|avancar|prosseguir/.test(normalize(`${e.text} ${e.id} ${e.name} ${e.aria}`)) ? 20 : 0)
      + (e.type === 'submit' || (e.tag === 'button' && !e.type) ? 10 : 0) + (e.form === form ? 1 : 0);
    buttons.sort((a, b) => buttonScore(b) - buttonScore(a));
    const button = buttons.find(e => buttonScore(e) >= 10);
    const authContext = /(?:^|[\/_?&=.-])(login|logon|signin|sign-in|auth|autenticar|acesso)(?:$|[\/_?&=.-])/i.test(frame.url()) ? 30 : 0;
    const confidence = (user ? userScore(user) : 0) + (password ? 20 : 0) + (button ? buttonScore(button) : 0) + authContext;
    if (strict && confidence < 50) continue;
    return { frame, user, password, button, confidence, step: password ? 'password' : 'username' };
  }
  return null;
}

async function discoverMenus(page) {
  const result = [];
  for (const frame of page.frames()) {
    const items = await inspect(frame).catch(() => []);
    const hasPrimaryNavigation = items.some(e => e.navigation && e.primaryNavigation);
    for (const item of items) {
      const name = (item.text || item.aria).replace(/\s+/g, ' ').trim();
      if (!name || name.length > 100 || item.disabled || item.editorControl || unsafe.test(normalize(`${name} ${item.href} ${item.id}`))) continue;
      if (/^(nov[oa]|adicionar|cadastrar|incluir|criar)(?:\s|$)/i.test(normalize(name))) continue;
      if (item.role === 'tab') continue;
      if (!['a', 'button'].includes(item.tag) && item.role !== 'link' && !item.navigation) continue;
      if (item.tag === 'input' || item.tag === 'select' || (item.type === 'submit' && item.form)) continue;
      const navigable = item.href && !/^(javascript:|#|mailto:|tel:)/i.test(item.href);
      if (!item.navigation) continue;
      if (hasPrimaryNavigation && !item.primaryNavigation) continue;
      if (navigable) {
        try { if (new URL(item.href, frame.url()).origin !== new URL(page.url()).origin) continue; } catch { continue; }
      }
      // Hidden descendants are discovered now and opened through their parent menu.
      if (!item.visible && !item.parents.length) continue;
      const parentNames = item.parents.map(selector => items.find(e => e.selector === selector)?.text).filter(Boolean);
      result.push({ ...item, name, parentNames, framePath: framePath(frame), frameName: frame.name() });
    }
  }
  if (!result.length) result.push({ selector: 'body', tag: 'body', type: '', name: 'Página inicial', text: 'Página inicial',
    visible: true, disabled: false, href: page.url(), parents: [], parentNames: [], framePath: [], frameName: '', virtual: true });
  return result;
}

async function login(page, credentials, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const submitted = new Set();
  let usedPassword = false, authenticatedSince = 0;
  while (Date.now() < deadline) {
    if (submitted.size) {
      const rejection = await authenticationFailure(page, credentials);
      if (rejection) throw Object.assign(new Error(`Autenticação recusada pelo sistema: ${rejection}`), { code: 'AUTH_REJECTED' });
    }
    const form = await findLogin(page, { strict: usedPassword });
    if (!form) {
      const challenge = await authenticationChallenge(page);
      if (challenge) throw Object.assign(new Error(challenge), { code: 'AUTH_CHALLENGE' });
      if (usedPassword) {
        authenticatedSince ||= Date.now();
        const menus = await discoverMenus(page);
        if (menus.some(e => e.visible && !e.virtual) || Date.now() - authenticatedSince >= authenticatedMenuSettleMs) return menus;
      }
      await pause(200);
      continue;
    }
    const fingerprint = JSON.stringify([page.url(), framePath(form.frame), form.user?.selector, form.password?.selector, form.button?.selector]);
    if (submitted.has(fingerprint)) { await pause(250); continue; }
    if (form.user) await form.frame.locator(form.user.selector).fill(credentials.SISTEMA_USER, { timeout: 15000 });
    if (form.password) {
      await form.frame.locator(form.password.selector).fill(credentials.SISTEMA_PASS, { timeout: 15000 });
      usedPassword = true;
      authenticatedSince = 0;
    }
    submitted.add(fingerprint);
    const control = form.button ? form.frame.locator(form.button.selector) : form.frame.locator((form.password || form.user).selector);
    await activateLoginControl(control, !!form.button);
    await pause(250);
  }
  if (usedPassword && !(await findLogin(page, { strict: true }))) {
      const menus = await discoverMenus(page);
      if (menus.some(e => e.visible)) return menus;
  }
  const rejection = await authenticationFailure(page, credentials);
  if (rejection) throw Object.assign(new Error(`Autenticação recusada pelo sistema: ${rejection}`), { code: 'AUTH_REJECTED' });
  throw new Error('Login não confirmado: as credenciais não foram aceitas, há uma etapa adicional ou a interface não ficou disponível.');
}

async function authenticationFailure(page, credentials = {}) {
  const selector = '[role="alert"],[role="alertdialog"],[aria-live="assertive"],.alert-danger,.error-message,.dialog-error,#dialogContainer';
  const redact = redactor([credentials.SISTEMA_USER, credentials.SISTEMA_PASS]);
  for (const frame of page.frames()) {
    const messages = await frame.locator(selector).evaluateAll(elements => elements.filter(el => {
      const style = getComputedStyle(el);
      return !!el.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }).map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500))).catch(() => []);
    for (const message of messages) {
      const normalized = normalize(message);
      const rejected = /(?:usuario|utilizador|user|email|e-mail|senha|password|credencia).{0,100}(?:invalid|incorret|nao reconhec|nao encontr|bloquead|desativad|inativ|expirad)/.test(normalized)
        || /(?:invalid|incorrect|wrong).{0,60}(?:user|password|credential)/.test(normalized)
        || /acesso negado|authentication failed|login failed|falha.{0,30}autenticacao/.test(normalized);
      if (rejected) return redact(message.replace(/\b(?:ok|fechar|close)\s*$/i, '').trim());
    }
  }
  return null;
}

async function authenticationChallenge(page) {
  for (const frame of page.frames()) {
    const challenges = frame.locator('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="token" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],[class*="captcha" i]');
    for (let index = 0; index < Math.min(await challenges.count().catch(() => 0), 5); index++) {
      if (await challenges.nth(index).isVisible().catch(() => false)) return 'O acesso exige MFA, código temporário ou CAPTCHA; conclua essa etapa manualmente antes da varredura.';
    }
  }
  return null;
}

async function activateLoginControl(control, isButton = true) {
  await control.waitFor({ state: 'visible', timeout: 15000 });
  try {
    // A native click waits until animated login panels enter the viewport and
    // accept pointer events. Keeping readiness and activation in one action
    // also supports portals that remove siblings during the transition.
    if (isButton) await control.click({ timeout: 15000 });
    else await control.press('Enter', { timeout: 15000 });
  } catch {
    throw new Error('O controle de autenticação não ficou disponível; ele está desabilitado, fora da área visível ou coberto por outra janela.');
  }
}

async function openMenu(page, entry, options = {}) {
  await waitForInterface(page, options);
  if (entry.virtual) return;
  const frame = resolveFrame(page, entry.framePath);
  if (!frame) throw new Error('Frame do menu indisponível.');
  const target = frame.locator(entry.selector);
  for (const [index, selector] of entry.parents.entries()) {
    const parent = frame.locator(selector);
    const next = frame.locator(entry.parents[index + 1] || entry.selector);
    // Inspect the next level, not the final leaf: clicking an already open root
    // would close the entire branch while a deeper submenu is still collapsed.
    if (!(await next.isVisible())) {
      const name = await parent.innerText();
      if (unsafe.test(normalize(name))) throw new Error('Ação de menu ignorada por alterar dados ou encerrar sessão.');
      try {
        // Background browser windows can throttle the animation frames used by
        // hover. Native keyboard activation remains available after hit testing.
        for (let hoverAttempt = 0; hoverAttempt < 3 && !(await next.isVisible()); hoverAttempt++) {
          await parent.hover({ timeout: 3000, force: true }).catch(error => {
            if (error.name !== 'TimeoutError') throw error;
          });
          await next.waitFor({ state: 'visible', timeout: 700 }).catch(() => {});
        }
        if (!(await next.isVisible())) await activateMenuControl(parent);
        await next.waitFor({ state: 'visible', timeout: 4000 });
      } catch (error) {
        error.code = 'MENU_HIDDEN';
        error.action = { phase: 'expandir submenu', parentSelector: selector, nextSelector: entry.parents[index + 1] || entry.selector };
        throw error;
      }
    }
  }
  await activateMenuControl(target);
  await waitForInterface(page, options);
}

async function activateMenuControl(control) {
  await control.waitFor({ state: 'visible', timeout: 4000 });
  const native = await control.evaluate(el => {
    if (el.matches('a[href][target="_blank"]')) el.setAttribute('target', '_self');
    return el.matches('a[href],button,input[type="button"],[role="link"]');
  });
  if (!native) return control.click({ timeout: 5000 });
  try {
    // Some SPAs bind pointer activation and keyboard activation differently.
    // Playwright's native click waits for visibility, stability and hit testing
    // while preserving the same behavior a user gets from the menu.
    await control.click({ timeout: 5000 });
  } catch {
    const error = new Error('O item do menu está oculto, desabilitado ou coberto por outro elemento.');
    error.code = 'MENU_BLOCKED';
    throw error;
  }
}

function redactor(secrets) {
  const variants = secrets.filter(Boolean).flatMap(s => [s, encodeURIComponent(s), encodeURI(s), Buffer.from(s).toString('base64')]).sort((a, b) => b.length - a.length);
  return value => variants.reduce((text, secret) => text.split(secret).join('[oculto]'), String(value));
}
function safeUrl(value, redact) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/;[^/]*/g, ''); return redact(url.toString()); }
  catch { return '[URL indisponível]'; }
}
async function writeDiagnostic(page, out, error, secrets = [], requestedUrl = '') {
  const redact = redactor(secrets);
  const frames = [];
  for (const frame of page?.frames() || []) {
    const items = await inspect(frame).catch(() => []);
    frames.push({ name: frame.name(), path: framePath(frame), url: safeUrl(frame.url(), redact),
      title: await frame.title().catch(() => ''),
      selectors: items.map(({ selector, tag, type, name, id, visible }) => ({
        selector: redact(id) === id ? selector : '[seletor oculto]', tag, type, name, id, visible,
      })) });
  }
  const data = { timestamp: new Date().toISOString(), url: safeUrl(page?.url() || requestedUrl, redact),
    title: await page?.title().catch(() => '') || '',
    // Do not save Playwright call logs: they may contain filled values and request URLs.
    error: redact(String(error?.message || error).split('\n')[0]).replace(/https?:\/\/[^\s"']+/g, url => safeUrl(url, redact)),
    action: error?.action || null, code: error?.code || null, network: networkDiagnostics(page), interface: await diagnosticState(page), frames };
  const file = path.join(out, `diagnostico-${Date.now()}-${require('node:crypto').randomUUID()}.json`);
  // Redact each string before JSON escaping so quotes/backslashes in secrets are covered.
  fs.writeFileSync(file, JSON.stringify(data, (_key, value) => typeof value === 'string' ? redact(value) : value, 2));
  return file;
}

module.exports = { inspect, findLogin, login, discoverMenus, openMenu, activateMenuControl, resolveFrame, redactor, safeUrl, writeDiagnostic };
