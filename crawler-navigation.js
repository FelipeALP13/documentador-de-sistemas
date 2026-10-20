const ui = require('./crawler-interface');
// A position-based CSS selector can change after JSP re-renders the menu.
const key = entry => JSON.stringify([entry.framePath, entry.parentNames || [], entry.name, entry.href]);
const semanticKey = entry => JSON.stringify([entry.framePath, entry.parentNames || [], entry.name]);
const nameKey = entry => JSON.stringify([entry.framePath, entry.name]);
const findCurrent = (entries, entry) => entries.find(candidate => key(candidate) === key(entry))
  || entries.find(candidate => semanticKey(candidate) === semanticKey(entry))
  || entries.find(candidate => JSON.stringify(candidate.framePath) === JSON.stringify(entry.framePath) && candidate.name === entry.name);
const refreshEntry = (found, entry) => {
  if (!found) return entry;
  const hasDiscoveredPath = found.parentNames?.length
    && JSON.stringify(found.parentNames) === JSON.stringify(entry.parentNames || []);
  return hasDiscoveredPath ? found : { ...found, parents: entry.parents, parentNames: entry.parentNames };
};
async function walkMenus(page, queue, {
  maxMenus = 1000, maxConsecutiveErrors = 3, discover = () => ui.discoverMenus(page),
  open = entry => ui.openMenu(page, entry), visit, recover, report, onQueue = () => {}, onWarning = () => {}, onRetry = () => {},
}) {
  const known = new Set(queue.map(key));
  const knownSemantic = new Set(queue.map(semanticKey));
  const seenCounts = new Map();
  for(const entry of queue)seenCounts.set(nameKey(entry),(seenCounts.get(nameKey(entry))||0)+1);
  let attempted = 0, visited = 0, skipped = 0, consecutiveErrors = 0, failures = 0, interrupted = false;
  for (let index = 0; index < queue.length && attempted < maxMenus; index++) {
    const entry = queue[index];
    attempted++;
    try {
      let current, openResult;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const found=findCurrent(await discover(),entry);
          current=refreshEntry(found,entry);
          openResult=await open(current);
          break;
        } catch (error) {
          const transient = error.name === 'TimeoutError' || ['MENU_MISSING','MENU_HIDDEN','MENU_BLOCKED','UI_BLOCKED','HTTP_5XX','NETWORK_FAILURE','SESSION_EXPIRED'].includes(error.code);
          if (attempt || !transient) throw error;
          onRetry(entry);
          await recover();
        }
      }
      const discovered=[];
      const groups=new Map();
      for(const raw of await discover()){
        if(raw.virtual)continue;
        const group=groups.get(nameKey(raw))||[];group.push(raw);groups.set(nameKey(raw),group);
      }
      for(const [groupKey,items] of groups){
        const previous=seenCounts.get(groupKey)||0;
        seenCounts.set(groupKey,Math.max(previous,items.length));
        for(const raw of items.slice(previous)){
         const next=(raw.parentNames||[]).length?raw:{...raw,parents:[...(current.parents||[]),current.selector],parentNames:[...(current.parentNames||[]),current.name]};
         discovered.push(next);
        }
      }
      for (const next of discovered) {
        // A virtual start page is only an initial fallback for systems without
        // navigation. It must not become a queued menu after opening a leaf URL.
        if (next.virtual) continue;
        // Menus rendered in a portal can appear as new roots after their group
        // opens. Attach them to the current branch without relying on a module
        // name; content actions are explored separately by crawler-content.
        if (!known.has(key(next))&&!knownSemantic.has(semanticKey(next))) {
          known.add(key(next));knownSemantic.add(semanticKey(next));queue.push(next);
        }
      }
      onQueue();
      const isGroup = queue.some(next => next!==entry&&JSON.stringify(next.framePath) === JSON.stringify(current.framePath) && next.parents.includes(current.selector));
      if(!isGroup&&openResult?.changed===false){
        throw Object.assign(new Error('O item foi acionado, mas o conteúdo da tela não mudou; nenhuma captura incorreta foi gravada.'),{code:'SCREEN_NOT_OPENED',recoverable:true});
      }
      if (!isGroup||openResult?.changed===true) { await visit(current); visited++; }
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
