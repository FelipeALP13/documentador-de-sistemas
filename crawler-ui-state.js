const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const dialogs = '[role="dialog"],[role="alertdialog"],.swal2-popup,.swal2-modal,.sweet-alert,.swal-modal,.bootbox,.modal,.dialog';
const loaders = '.blockOverlay,.blockUI.blockOverlay,.blockUI.blockMsg,.loadingoverlay,.loading-overlay,.loader-overlay,.preloader,[aria-busy="true"],[role="progressbar"]';

async function snapshot(frame) {
  return frame.evaluate(({ dialogs, loaders }) => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0';
    const selector = el => {
      // Structural selectors avoid copying identifiers that could contain user data.
      const parts = [];
      for (let node = el; node?.nodeType === 1; node = node.parentElement) {
        const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.tagName === node.tagName) : [node];
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
        if (node.tagName === 'BODY') break;
      }
      return parts.join(' > ');
    };
    const candidates = [...document.querySelectorAll(dialogs)].filter(visible);
    const messageText = el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const parts = [];
      while (walker.nextNode()) {
        const node = walker.currentNode, parent = node.parentElement;
        if (parent && !parent.closest('input,select,textarea,script,style') && visible(parent)) parts.push(node.textContent);
      }
      return parts.join(' ').slice(0, 2000);
    };
    const loadingText = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el) || el.children.length > 4) return false;
      const ownText = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      return /^(?:carregando|loading|aguarde|processando)(?:\.{0,3})?$/.test(ownText);
    });
    return {
      dialogs: candidates.filter(el => !candidates.some(other => other !== el && el.contains(other))).map(el => ({
        selector: selector(el), text: messageText(el),
        editable: [...el.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]),select,textarea')].some(visible),
        buttons: [...el.querySelectorAll('button,a,[role="button"]')].filter(visible).map(button => ({
          selector: selector(button), text: (button.innerText || button.getAttribute('aria-label') || '').trim(), type: button.getAttribute('type') || '',
        })),
      })),
      // Small, permanent footer spinners are not blocking overlays.
      loaders: [...document.querySelectorAll(loaders)].filter(el => {
        const rect = el.getBoundingClientRect();
        return visible(el) && (rect.width * rect.height > innerWidth * innerHeight * 0.2
          || (el.matches('.blockUI.blockMsg') && getComputedStyle(el).position === 'fixed'));
      }).concat(loadingText).filter((el,index,all)=>all.indexOf(el)===index).map(el => ({ selector: selector(el) })),
    };
  }, { dialogs, loaders });
}

function informational(dialog) {
  const text = dialog.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return !dialog.editable && dialog.buttons.length === 1
    && /sem dados|nenhum (?:registro|resultado|dado)|nao (?:ha|existem) (?:dados|registros|resultados)|nada encontrado/.test(text)
    && !/deseja|certeza|confirmar|excluir|deletar|remover|salvar|gravar|enviar|publicar|pagar|cancelar|encerrar|inativar|suspender/.test(text)
    && /^(ok|fechar|entendi)$/i.test(dialog.buttons[0].text)
    && dialog.buttons[0].type !== 'submit';
}

function prerequisite(dialog) {
  const text = dialog.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return !dialog.editable && dialog.buttons.length === 1
    && /^(ok|fechar|entendi)$/i.test(dialog.buttons[0].text)
    && dialog.buttons[0].type !== 'submit'
    && !/deseja|certeza|confirmar|excluir|deletar|remover|salvar|gravar|enviar|publicar|pagar|cancelar|encerrar|inativar|suspender|aprovar|reprovar/.test(text);
}

async function waitForInterface(page, { timeout = 30000, quietMs = 650, allowForms = false, onNotice = () => {}, failureCheck = () => null } = {}) {
  const deadline = Date.now() + timeout;
  let clearSince = 0;
  while (Date.now() < deadline) {
    let pending = false;
    for (const frame of page.frames()) {
      let state;
      try { state = await snapshot(frame); } catch { pending = true; continue; }
      pending ||= state.loaders.length > 0;
      for (const dialog of state.dialogs) {
        if (informational(dialog)) {
          pending = true;
          // Never force clicks or remove overlays; loading may temporarily cover OK.
          try {
            await frame.locator(dialog.buttons[0].selector).click({ timeout: Math.min(1000, Math.max(1, deadline - Date.now())), noWaitAfter: true });
            onNotice('Aviso informativo de ausência de dados fechado.');
          } catch { /* Retry only while the bounded loading deadline remains. */ }
        } else if (!(allowForms && dialog.editable)) {
          const safePrerequisite = prerequisite(dialog);
          const error = new Error(safePrerequisite
            ? 'A tela exige uma seleção ou informação anterior; nenhuma confirmação foi acionada.'
            : 'Diálogo requer interação; nenhuma confirmação foi acionada.');
          error.code = safePrerequisite ? 'UI_PREREQUISITE' : 'UI_DIALOG';
          error.recoverable = safePrerequisite;
          throw error;
        }
      }
    }
    const networkFailure = failureCheck();
    if (networkFailure) throw networkFailure;
    if (pending) clearSince = 0;
    else {
      clearSince ||= Date.now();
      if (Date.now() - clearSince >= quietMs) return;
    }
    await pause(100);
  }
  const error = new Error('A interface permaneceu bloqueada por carregamento ou aviso.');
  error.code = 'UI_BLOCKED';
  error.recoverable = true;
  throw error;
}

async function diagnosticState(page) {
  const result = [];
  for (const frame of page?.frames() || []) {
    const state = await snapshot(frame).catch(() => null);
    if (state) result.push({ name: frame.name(), ...state });
  }
  return result;
}
module.exports = { waitForInterface, diagnosticState, informational, prerequisite };
