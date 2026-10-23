const jpeg = require('jpeg-js');

function analyzeJpeg(bytes) {
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const total = image.width * image.height;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 50000)));
  let samples = 0;
  let nearWhite = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (red >= 248 && green >= 248 && blue >= 248) nearWhite++;
      sum += luminance;
      sumSquares += luminance * luminance;
      samples++;
    }
  }
  const mean = sum / samples;
  const deviation = Math.sqrt(Math.max(0, sumSquares / samples - mean * mean));
  const nearWhiteRatio = nearWhite / samples;
  return {
    width: image.width,
    height: image.height,
    mean,
    deviation,
    nearWhiteRatio,
    blank: nearWhiteRatio >= 0.985 || (deviation < 3 && (mean >= 247 || mean <= 8)),
  };
}

async function renderFrame(page) {
  await page.evaluate(() => new Promise(resolve => {
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (document.fonts?.ready) document.fonts.ready.then(done, done);
    else done();
  })).catch(() => {});
}

async function hasMeaningfulContent(page) {
  for (const frame of page.frames()) {
    const meaningful = await frame.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        return !!element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const loadingSurface = [...document.querySelectorAll('[class*="load" i],[class*="spinner" i],[aria-busy="true"],[role="progressbar"]')]
        .some(element => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          const position = getComputedStyle(element).position;
          return ['fixed', 'absolute'].includes(position) && rect.width * rect.height >= innerWidth * innerHeight * 0.75;
        });
      if (loadingSurface) return false;
      const loading = /^(?:carregando|loading|aguarde|processando)(?:\.{0,3})?$/i;
      const exposed = element => {
        const rect = element.getBoundingClientRect();
        const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === element || element.contains(top));
      };
      const candidates = [...document.querySelectorAll('main,h1,h2,h3,p,label,input:not([type="hidden"]),select,textarea,button,a[href],table,[role="tab"],[role="dialog"]')];
      if (candidates.some(element => {
        if (!visible(element) || !exposed(element) || element.closest('[class*="load" i],[class*="spinner" i],[aria-busy="true"]')) return false;
        if (element.matches('input,select,textarea,button,a[href],table,[role="tab"],[role="dialog"]')) return true;
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length >= 3 && !loading.test(text);
      })) return true;
      return [...document.querySelectorAll('img,canvas,svg')].some(element => {
        const rect = element.getBoundingClientRect();
        return visible(element) && exposed(element) && !element.closest('[class*="load" i],[class*="spinner" i],[aria-busy="true"]')
          && rect.width * rect.height >= innerWidth * innerHeight * 0.03;
      });
    }).catch(() => false);
    if (meaningful) return true;
  }
  return false;
}

async function suppressStaleLoading(page) {
  let hidden = 0;
  for (const frame of page.frames()) {
    hidden += await frame.evaluate(() => {
      if (window.__documentadorSuppressedLoading?.length) return window.__documentadorSuppressedLoading.length;
      const visible = element => {
        const style = getComputedStyle(element);
        return !!element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const area = element => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const interactive = 'input,select,textarea,button,a[href],[role="button"],[role="dialog"],[role="alertdialog"]';
      const loadingName = element => /load|loading|loader|spinner|preload|aguarde|processando|blockui|block-overlay|busy/i
        .test(`${element.id} ${element.className} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('aria-busy') || ''}`);
      const candidates = new Set([...document.querySelectorAll('[class*="load" i],[class*="spinner" i],[class*="blockui" i],[aria-busy="true"],[role="progressbar"]')]);
      const meaningful = [...document.querySelectorAll('main input:not([type="hidden"]),main select,main textarea,main button,form input:not([type="hidden"]),form select,form textarea,form button')]
        .filter(visible).slice(0, 40);
      for (const control of meaningful) {
        const rect = control.getBoundingClientRect();
        const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)));
        if (!top || top === control || control.contains(top)) continue;
        for (let node = top; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (['fixed', 'absolute'].includes(style.position) && area(node) >= viewportArea * 0.65) {
            candidates.add(node);
            break;
          }
        }
      }
      const safe = [...candidates].filter(element => {
        if (!visible(element) || element.matches('[role="dialog"],[role="alertdialog"],.modal') || element.closest('[role="dialog"],[role="alertdialog"],.modal')) return false;
        const style = getComputedStyle(element);
        const large = ['fixed', 'absolute'].includes(style.position) && area(element) >= viewportArea * 0.65;
        if (!large || element.querySelector(interactive)) return false;
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return loadingName(element) || !text || /^(?:carregando|loading|aguarde|processando)(?:\.{0,3})?$/i.test(text);
      }).filter(element => ![...candidates].some(other => other !== element && other.contains(element)));
      window.__documentadorSuppressedLoading = safe.map(element => ({ element, style: element.getAttribute('style') }));
      for (const { element } of window.__documentadorSuppressedLoading) element.style.setProperty('visibility', 'hidden', 'important');
      return safe.length;
    }).catch(() => 0);
  }
  return hidden;
}

async function restoreSuppressedLoading(page) {
  for (const frame of page?.frames() || []) await frame.evaluate(() => {
    for (const item of window.__documentadorSuppressedLoading || []) {
      if (!item.element?.isConnected) continue;
      if (item.style === null) item.element.removeAttribute('style');
      else item.element.setAttribute('style', item.style);
    }
    delete window.__documentadorSuppressedLoading;
  }).catch(() => {});
}

async function takeUsableScreenshot(page, { timeout = 30000, interval = 500, staleLoaderMs = 4000 } = {}) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeout;
  let lastMetrics = null;
  let lastError = null;
  do {
    try {
      await renderFrame(page);
      const bytes = await page.screenshot({ type: 'jpeg', quality: 84, fullPage: false, timeout: Math.min(15000, Math.max(1000, deadline - Date.now())) });
      const metrics = analyzeJpeg(bytes);
      if (!metrics.blank || await hasMeaningfulContent(page)) return { bytes, metrics };
      lastMetrics = metrics;
      if (Date.now() - startedAt >= staleLoaderMs && await suppressStaleLoading(page)) {
        await renderFrame(page);
        const recoveredBytes = await page.screenshot({ type: 'jpeg', quality: 84, fullPage: false, timeout: Math.min(15000, Math.max(1000, deadline - Date.now())) });
        const recoveredMetrics = analyzeJpeg(recoveredBytes);
        if (!recoveredMetrics.blank || await hasMeaningfulContent(page)) return { bytes: recoveredBytes, metrics: recoveredMetrics, recoveredLoading: true };
        await restoreSuppressedLoading(page);
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await page.waitForTimeout(Math.min(interval, deadline - Date.now()));
  } while (Date.now() < deadline);

  if (lastMetrics) {
    const error = new Error(`A tela permaneceu visualmente em branco (${(lastMetrics.nearWhiteRatio * 100).toFixed(1)}% branco) e não foi registrada.`);
    error.code = 'SCREEN_BLANK';
    error.recoverable = true;
    throw error;
  }
  await restoreSuppressedLoading(page);
  throw lastError || new Error('Não foi possível gerar uma captura da tela.');
}

module.exports = { analyzeJpeg, hasMeaningfulContent, suppressStaleLoading, restoreSuppressedLoading, takeUsableScreenshot };
