const ui = require('./crawler-interface');
// A position-based CSS selector can change after JSP re-renders the menu.
const key = entry => JSON.stringify([entry.framePath, entry.parentNames || [], entry.name, entry.href]);

async function walkMenus(page, queue, {
  maxMenus = 1000, maxConsecutiveErrors = 3, discover = () => ui.discoverMenus(page),
  open = entry => ui.openMenu(page, entry), visit, recover, report, onQueue = () => {}, onWarning = () => {}, onRetry = () => {},
}) {
  const known = new Set(queue.map(key));
  let attempted = 0, visited = 0, skipped = 0, consecutiveErrors = 0, failures = 0, interrupted = false;
  for (let index = 0; index < queue.length && attempted < maxMenus; index++) {
    const entry = queue[index];
    attempted++;
    try {
      let current;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          current = (await discover()).find(e => key(e) === key(entry));
          if (!current) throw Object.assign(new Error('Menu não encontrado ao retornar à página inicial.'), { code: 'MENU_MISSING' });
          await open(current);
          break;
        } catch (error) {
          const transient = error.name === 'TimeoutError' || ['MENU_MISSING','MENU_HIDDEN','MENU_BLOCKED','UI_BLOCKED','HTTP_5XX','NETWORK_FAILURE','SESSION_EXPIRED'].includes(error.code);
          if (attempt || !transient) throw error;
          onRetry(entry);
          await recover();
        }
      }
      const discovered = await discover();
      for (const next of discovered) {
        // A virtual start page is only an initial fallback for systems without
        // navigation. It must not become a queued menu after opening a leaf URL.
        if (next.virtual) continue;
        if (!known.has(key(next))) { known.add(key(next)); queue.push(next); }
      }
      onQueue();
      const isGroup = discovered.some(next => JSON.stringify(next.framePath) === JSON.stringify(current.framePath) && next.parents.includes(current.selector));
      if (!isGroup) { await visit(current); visited++; }
      consecutiveErrors = 0;
    } catch (error) {
      error.action = { name: entry.name, selector: entry.selector, framePath: entry.framePath, ...error.action };
      const outcome = await report([...entry.parentNames || [], entry.name].join(' > '), error);
      const recoverable = error.recoverable || outcome?.recoverable;
      if (recoverable) { skipped++; consecutiveErrors = 0; }
      else { failures++; consecutiveErrors++; }
      if (!recoverable && consecutiveErrors >= maxConsecutiveErrors) {
        interrupted = true;
        onWarning(`Varredura interrompida após ${consecutiveErrors} falhas consecutivas; capturas já feitas foram preservadas.`);
        break;
      }
      try { await recover(); }
      catch (recoveryError) {
        await report('Recuperação da navegação', recoveryError);
        interrupted = true;
        onWarning('Não foi possível recuperar a navegação. As capturas já feitas foram preservadas.');
        break;
      }
    }
  }
  const pending = queue.slice(attempted).map(e => ({ name: e.name, parents: e.parentNames || [], framePath: e.framePath }));
  if (pending.length && !interrupted) onWarning(`Limite de ${maxMenus} menus atingido; ${pending.length} itens não foram visitados.`);
  return { attempted, visited, skipped, failures, pending, interrupted, complete: !failures && !pending.length && !interrupted };
}
module.exports = { walkMenus };
