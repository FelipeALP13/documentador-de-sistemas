const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { login, writeDiagnostic } = require('./crawler-interface');
const credentials = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '.env')));

(async () => {
  const browser = await chromium.launch({ headless: false, channel: process.env.DOCUMENTADOR_BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(credentials.SISTEMA_URL, { waitUntil: 'domcontentloaded' });
    await login(page, credentials);
    await context.storageState({ path: path.join(__dirname, 'estado-sessao.json') });
    console.log('Sessão autenticada salva para os scripts de documentação.');
  } catch (error) {
    const out = path.join(__dirname, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(out, { recursive: true });
    const file = await writeDiagnostic(page, out, error, [credentials.SISTEMA_USER, credentials.SISTEMA_PASS]);
    console.error('Falha de autenticação. Diagnóstico:', file);
    process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(() => { console.error('Falha ao inicializar a autenticação.'); process.exitCode = 1; });
