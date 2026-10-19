const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { main: scan } = require('../varredura-completa');
const { main: generate } = require('../gerar-manual');
const { createProxyClient } = require('./proxy-client');

let window;
let busy = false;

function validFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Escolha uma pasta de saída válida.');
  return path.resolve(folder);
}

function artifactsRoot(folder) {
  return path.join(validFolder(folder), 'artifacts');
}

function cleanError(error, secrets = []) {
  let message = String(error?.message || error).split('\n')[0];
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[oculto]');
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[oculto]');
}

function sendLog(...parts) {
  if (!window?.isDestroyed()) window.webContents.send('progress', parts.join(' '));
}

async function runExclusive(work, secrets) {
  if (busy) return { ok: false, error: 'Já existe uma operação em andamento.' };
  busy = true;
  try {
    const result = await work();
    return { ok: true, result };
  } catch (error) {
    const message = cleanError(error, secrets);
    sendLog(`Erro: ${message}`);
    return { ok: false, error: message };
  } finally {
    busy = false;
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 950,
    height: 820,
    minWidth: 720,
    minHeight: 650,
    title: 'Documentador de Sistemas',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('defaults', () => ({ folder: path.join(app.getPath('documents'), 'Documentacao-de-Sistemas'), version: app.getVersion() }));

  ipcMain.handle('choose-folder', async () => {
    const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return selected.canceled ? null : selected.filePaths[0];
  });

  ipcMain.handle('open-folder', async (_event, folder) => {
    const target = validFolder(folder);
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('scan', async (_event, input) => runExclusive(async () => {
    const url = new URL(String(input?.url || '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Informe a URL HTTP(S) do sistema, sem credenciais na URL.');
    const user = String(input?.user || '').trim();
    const password = String(input?.password || '');
    if (!user || !password) throw new Error('Informe o usuário/e-mail e a senha do sistema.');
    const root = artifactsRoot(input.folder);
    fs.mkdirSync(root, { recursive: true });
    sendLog('Iniciando varredura. O navegador será aberto em segundo plano.');
    const result = await scan({
      credentials: { SISTEMA_URL: url.toString(), SISTEMA_USER: user, SISTEMA_PASS: password },
      artifactsRoot: root,
      browserChannel: input.browser === 'chrome' ? 'chrome' : 'msedge',
      log: sendLog,
    });
    return result;
  }, [input?.user, input?.password, input?.accessCode]));

  ipcMain.handle('check-images', async (_event, input) => runExclusive(async () => {
    return generate(['--dry-run'], { artifactsRoot: artifactsRoot(input?.folder), log: sendLog });
  }));

  ipcMain.handle('generate', async (_event, input) => runExclusive(async () => {
    const proxy = await createProxyClient(input?.serviceUrl, input?.accessCode);
    const config = { apiKey: '', model: proxy.info.model, intervalMs: 15000, timeoutMs: 90000, attempts: 4 };
    sendLog('Iniciando a geração. O progresso é salvo após cada imagem.');
    await generate([], { artifactsRoot: artifactsRoot(input.folder), config, generateImage: proxy.generateImage, log: sendLog });
    return true;
  }, [input?.accessCode]));

  createWindow();
});

app.on('window-all-closed', () => app.quit());

module.exports = { validFolder, artifactsRoot, cleanError };
