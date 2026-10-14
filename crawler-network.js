const monitorKey = Symbol('documentador-network');

function attachNetworkMonitor(page, sanitizeUrl) {
  let enabled = false, started = new WeakSet(), failures = [];
  const onRequest = request => {
    if (!enabled || !['document', 'xhr', 'fetch'].includes(request.resourceType())) return;
    try { if (new URL(request.url()).origin === new URL(page.url()).origin) started.add(request); } catch {}
  };
  const onResponse = response => {
    if (!started.has(response.request()) || response.status() < 400) return;
    failures.push({ url: sanitizeUrl(response.url()), status: response.status(), type: response.request().resourceType() });
    failures = failures.slice(-20);
  };
  const onFailure = request => {
    if (!started.has(request)) return;
    const reason = request.failure()?.errorText?.match(/net::[A-Z_]+/)?.[0] || 'NETWORK_ERROR';
    if (reason === 'net::ERR_ABORTED') return;
    failures.push({ url: sanitizeUrl(request.url()), reason, type: request.resourceType() });
    failures = failures.slice(-20);
  };
  const onPageError = error => {
    if (!enabled) return;
    const type = ['ReferenceError','TypeError','SyntaxError','RangeError'].includes(error.name) ? error.name : 'Error';
    failures.push({ javascript: type });
    failures = failures.slice(-20);
  };
  const monitor = {
    reset() { enabled = true; started = new WeakSet(); failures = []; },
    snapshot() { return failures.slice(); },
    failure() {
      const failure = failures.at(-1);
      if (!failure) return null;
      if (failure.javascript) return Object.assign(new Error(`A página apresentou um erro JavaScript (${failure.javascript}) ao abrir a tela.`), { code: 'PAGE_SCRIPT_ERROR' });
      const message = failure.status ? `O servidor retornou HTTP ${failure.status} ao abrir ${failure.url}.` : `Falha de rede ao abrir ${failure.url}: ${failure.reason}.`;
      const code = failure.status >= 500 ? 'HTTP_5XX' : failure.status ? `HTTP_${failure.status}` : 'NETWORK_FAILURE';
      return Object.assign(new Error(message), { code });
    },
    dispose() { page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailure); page.off('pageerror', onPageError); delete page[monitorKey]; },
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailure);
  page.on('pageerror', onPageError);
  page[monitorKey] = monitor;
  return monitor;
}
const networkDiagnostics = page => page?.[monitorKey]?.snapshot() || [];
module.exports = { attachNetworkMonitor, networkDiagnostics };
