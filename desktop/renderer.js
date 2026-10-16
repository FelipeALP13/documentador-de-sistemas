const $ = id => document.getElementById(id);
const log = text => {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString('pt-BR')}  ${text}`;
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
};

let running = false;
function data() {
  return {
    url: $('url').value,
    user: $('user').value,
    password: $('password').value,
    serviceUrl: $('serviceUrl').value,
    accessCode: $('accessCode').value,
    browser: $('browser').value,
    folder: $('folder').value,
  };
}

async function run(action, started) {
  if (running) return;
  running = true;
  document.querySelectorAll('button:not(.password-toggle)').forEach(button => button.disabled = true);
  $('status').textContent = started;
  log(started);
  try {
    const result = await action(data());
    const partial=result.ok && (result.result?.complete===false || result.result?.errors>0);
    $('status').textContent = !result.ok ? 'Falha' : partial ? 'Varredura parcial' : 'Concluído';
    if (partial) log(`Varredura parcial: ${result.result.records} capturas, ${result.result.errors} erros, ${result.result.pending||0} menus pendentes. Consulte o manifesto e os diagnósticos.`);
    else if (result.ok) log('Operação concluída.');
    else log(result.error);
  } catch (error) {
    $('status').textContent = 'Falha';
    log(error.message);
  } finally {
    running = false;
    document.querySelectorAll('button:not(.password-toggle)').forEach(button => button.disabled = false);
  }
}

$('togglePassword').addEventListener('click', () => {
  const input = $('password');
  const button = $('togglePassword');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Ocultar' : 'Mostrar';
  button.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  button.setAttribute('aria-pressed', String(visible));
  input.focus();
});

window.documentador.onProgress(log);
window.documentador.defaults().then(({ folder, version }) => { $('folder').value = folder; document.title = `Documentador de Sistemas ${version}`; });
$('choose').addEventListener('click', async () => {
  const folder = await window.documentador.chooseFolder();
  if (folder) $('folder').value = folder;
});
$('open').addEventListener('click', () => window.documentador.openFolder($('folder').value));
$('scan').addEventListener('click', () => run(window.documentador.scan, 'Varredura em andamento…'));
$('check').addEventListener('click', () => run(window.documentador.checkImages, 'Conferindo imagens…'));
$('generate').addEventListener('click', () => run(window.documentador.generate, 'Gerando manual…'));
