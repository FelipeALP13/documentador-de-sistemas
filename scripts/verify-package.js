const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const files = asar.listPackage(archive);
const forbidden = files.filter(file => /(?:^|[\\/])(?:\.env(?:\..*)?|estado-sessao\.json|artifacts|proxy|crawler\.test\.js)(?:[\\/]|$)/.test(file));
assert.deepEqual(forbidden, [], 'Arquivos privados ou de desenvolvimento no pacote');
const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(pkg.version, require('../package.json').version);
assert.ok(files.some(f => /[\\/]crawler-interface\.js$/.test(f)));
for (const file of ['varredura-completa.js', 'crawler-interface.js', 'crawler-ui-state.js', 'crawler-navigation.js', 'crawler-content.js', 'crawler-network.js', 'desktop/main.js', 'desktop/renderer.js', 'desktop/proxy-client.js', 'gemini-client.js']) {
  assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), `Pacote desatualizado: ${file}`);
}
const key = require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))).GEMINI_API_KEY;
const archiveBytes = fs.readFileSync(archive);
assert.ok(!/AIza[0-9A-Za-z_-]{35}/.test(archiveBytes.toString('utf8')), 'Chave API no pacote');
if (key) assert.ok(!archiveBytes.includes(Buffer.from(key)), 'Chave local no pacote');
const portable = path.join(root, `dist/Documentador-de-Sistemas-${pkg.version}-portable.exe`);
const exe = fs.readFileSync(portable);
assert.equal(exe.subarray(0, 2).toString(), 'MZ');
if (key) assert.ok(!exe.includes(Buffer.from(key)), 'Chave local no executável');
console.log(JSON.stringify({ version: pkg.version, privateFiles: forbidden.length, apiKeyFound: false, portable, bytes: exe.length }, null, 2));
