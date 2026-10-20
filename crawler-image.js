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

async function takeUsableScreenshot(page, { timeout = 30000, interval = 500 } = {}) {
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
  throw lastError || new Error('Não foi possível gerar uma captura da tela.');
}

module.exports = { analyzeJpeg, hasMeaningfulContent, takeUsableScreenshot };
