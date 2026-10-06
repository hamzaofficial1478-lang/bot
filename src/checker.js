const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { parseProxy } = require('./proxy');
const store = require('./store');

// Added to the browser's normal user agent so these visits are easy to spot
// (and filter out) in your server logs. The tool never pretends to be anything else.
const TAG = 'SiteGeoCheck/1.0';
const VIEWPORT = { width: 1366, height: 768 };
const PAGE_TIMEOUT = 45000;

const EUROPE = new Set([
  'AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB',
  'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'SM', 'UA', 'VA',
]);

const GEO_SERVICES = [
  {
    url: 'https://ipwho.is/',
    map: (d) => d.success !== false && {
      ip: d.ip, city: d.city, region: d.region, country: d.country, countryCode: d.country_code,
      isp: d.connection && d.connection.isp,
    },
  },
  {
    url: 'https://ipapi.co/json/',
    map: (d) => !d.error && {
      ip: d.ip, city: d.city, region: d.region, country: d.country_name, countryCode: d.country_code,
      isp: d.org,
    },
  },
];

// Common cookie/consent banners. EU visitors should normally see one of these.
const CONSENT_SELECTORS = [
  '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '.qc-cmp2-container',
  '#didomi-host', '.cky-consent-container', '#cookie-law-info-bar', '#cmplz-cookiebanner-container',
  '.cc-window', '#moove_gdpr_cookie_info_bar', '[id*="cookie-banner" i]', '[class*="cookie-banner" i]',
  '[id*="cookie-consent" i]', '[class*="cookie-consent" i]', '[aria-label*="cookie" i]',
];

const CHALLENGE_TITLE = /just a moment|attention required|access denied|verify you are human|are you a robot/i;

function matchesTarget(target, countryCode) {
  if (!countryCode || target === 'ANY') return null;
  if (target === 'EU') return EUROPE.has(countryCode);
  return countryCode === target;
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/ERR_INVALID_AUTH_CREDENTIALS/.test(msg)) return 'The proxy rejected the username or password.';
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED/.test(msg)) {
    return "Couldn't connect through the proxy. Check the address, port and login.";
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "The website address couldn't be found (DNS lookup failed).";
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(msg)) {
    return 'The connection was refused or dropped.';
  }
  if (/ERR_CERT_/.test(msg)) return 'The site has an SSL certificate problem.';
  if (/Timeout .* exceeded/i.test(msg)) return `The page took longer than ${PAGE_TIMEOUT / 1000}s to load.`;
  if (/distribution 'chrome' is not found/i.test(msg)) {
    return 'Google Chrome isn\'t installed where Playwright expects it. Untick "Use my installed Google Chrome".';
  }
  if (/Executable doesn't exist/i.test(msg)) return 'The browser isn\'t installed yet. Run: npx playwright install chromium';
  return msg.split('\n')[0].slice(0, 300);
}

async function lookupExitIp(context) {
  const page = await context.newPage();
  try {
    for (const svc of GEO_SERVICES) {
      try {
        const res = await page.goto(svc.url, { timeout: 15000 });
        if (!res || !res.ok()) continue;
        const info = svc.map(await res.json());
        if (info && info.ip) return info;
      } catch {
        // fall through to the next lookup service
      }
    }
    return null;
  } finally {
    await page.close();
  }
}

async function defaultUserAgent(browser) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate(() => navigator.userAgent);
  } finally {
    await ctx.close();
  }
}

function redirectChain(response) {
  const chain = [];
  let req = response && response.request();
  while (req && req.redirectedFrom()) {
    req = req.redirectedFrom();
    chain.unshift(req.url());
  }
  return chain;
}

function cdnInfo(headers) {
  const h = headers || {};
  let edge = null;
  if (h['cf-ray']) edge = h['cf-ray'].split('-').pop();
  else if (h['x-amz-cf-pop']) edge = h['x-amz-cf-pop'];
  else if (h['x-served-by']) edge = h['x-served-by'];
  else if (h['x-vercel-id']) edge = h['x-vercel-id'].split(':')[0];
  return {
    server: h.server || null,
    cache: h['cf-cache-status'] || h['x-vercel-cache'] || h['x-cache'] || null,
    edge,
  };
}

// Runs inside the page before any of its scripts, so LCP and CLS get recorded.
function installObservers() {
  window.__geoCheck = { lcp: null, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__geoCheck.lcp = e.renderTime || e.loadTime || e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__geoCheck.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    // older engines without these entry types
  }
}

function collectMetrics() {
  const nav = performance.getEntriesByType('navigation')[0];
  const ms = (n) => (typeof n === 'number' && n > 0 ? Math.round(n) : null);
  const g = window.__geoCheck || {};
  return {
    ttfbMs: nav ? ms(nav.responseStart - nav.startTime) : null,
    domReadyMs: nav ? ms(nav.domContentLoadedEventEnd - nav.startTime) : null,
    loadMs: nav ? ms(nav.loadEventEnd - nav.startTime) : null,
    lcpMs: ms(g.lcp),
    cls: typeof g.cls === 'number' ? Math.round(g.cls * 1000) / 1000 : null,
  };
}

function collectPageInfo(consentSelectors) {
  const isShown = (el) => {
    if (el.shadowRoot) return true;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  let consentBanner = null;
  for (const sel of consentSelectors) {
    let found = [];
    try {
      found = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    if ([...found].some(isShown)) {
      consentBanner = sel;
      break;
    }
  }

  const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
  const currencies = [];
  if (/\bUSD\b|US\$/.test(text)) currencies.push('USD');
  if (/\bCAD\b|CA\$|C\$/.test(text)) currencies.push('CAD');
  if (/€|\bEUR\b/.test(text)) currencies.push('EUR');
  if (/£|\bGBP\b/.test(text)) currencies.push('GBP');
  if (!currencies.length && /\$\s?\d/.test(text)) currencies.push('$');

  return {
    title: document.title || '',
    lang: document.documentElement.lang || null,
    consentBanner,
    currencies,
    text,
  };
}

// Scrolls top to bottom so lazy-loaded images and sections actually load before
// the full-page screenshot, then returns to the top.
async function scrollThrough() {
  const step = Math.max(200, Math.round(window.innerHeight * 0.85));
  const pause = () => new Promise((r) => setTimeout(r, 200));
  for (let i = 0, y = 0; i < 60 && y < document.documentElement.scrollHeight; i++, y += step) {
    window.scrollTo(0, y);
    await pause();
  }
  window.scrollTo(0, 0);
  await pause();
}

async function checkLocation({ url, location, settings, outDir, index }) {
  const result = { status: 'running', startedAt: new Date().toISOString() };
  const prefix = String(index + 1).padStart(2, '0');
  let browser;

  try {
    browser = await chromium.launch({
      headless: !settings.showBrowser,
      channel: settings.useChrome ? 'chrome' : undefined,
      proxy: parseProxy(location.proxy),
    });

    const userAgent = `${await defaultUserAgent(browser)} ${TAG}`;
    const context = await browser.newContext({ viewport: VIEWPORT, locale: location.locale, userAgent });

    result.exit = await lookupExitIp(context);
    result.regionMatch = result.exit ? matchesTarget(location.target, result.exit.countryCode) : null;

    const page = await context.newPage();
    await page.addInitScript(installObservers);

    const net = { requests: 0, bytes: 0, failed: [], badStatus: [] };
    const sizeLookups = [];
    const consoleErrors = [];
    page.on('request', () => net.requests++);
    page.on('requestfinished', (req) => {
      sizeLookups.push(req.sizes().then((s) => { net.bytes += s.responseBodySize + s.responseHeadersSize; }, () => {}));
    });
    page.on('requestfailed', (req) => {
      net.failed.push({ url: req.url(), reason: (req.failure() || {}).errorText || 'failed' });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) net.badStatus.push({ url: res.url(), status: res.status() });
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 300)));

    const response = await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
    // Chromium hands back the proxy's own 407 page when the login is wrong.
    if (response && response.status() === 407) throw new Error('ERR_INVALID_AUTH_CREDENTIALS');
    result.httpStatus = response ? response.status() : null;
    result.redirects = redirectChain(response);
    result.finalUrl = page.url();
    result.cdn = cdnInfo(response && response.headers());

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    result.metrics = await page.evaluate(collectMetrics);

    if (settings.waitSeconds) await page.waitForTimeout(settings.waitSeconds * 1000);

    const { text, ...info } = await page.evaluate(collectPageInfo, CONSENT_SELECTORS);
    result.page = {
      ...info,
      words: text ? text.split(' ').length : 0,
      textHash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12),
      challenge: CHALLENGE_TITLE.test(info.title),
    };

    result.screenshots = {};
    await page.screenshot({ path: path.join(outDir, `${prefix}-top.jpg`), type: 'jpeg', quality: 70 });
    result.screenshots.top = `${prefix}-top.jpg`;

    await page.evaluate(scrollThrough);
    try {
      await page.screenshot({ path: path.join(outDir, `${prefix}-full.jpg`), type: 'jpeg', quality: 60, fullPage: true });
      result.screenshots.full = `${prefix}-full.jpg`;
    } catch {
      // very tall pages can exceed the browser's screenshot limit; the top shot still exists
    }

    await Promise.all(sizeLookups);
    result.network = {
      requests: net.requests,
      transferKb: Math.round(net.bytes / 1024),
      failed: net.failed.slice(0, 20),
      badStatus: net.badStatus.slice(0, 20),
    };
    result.consoleErrors = consoleErrors.slice(0, 20);
    result.status = 'done';
  } catch (err) {
    result.status = 'failed';
    result.error = friendlyError(err);
  } finally {
    result.finishedAt = new Date().toISOString();
    if (browser) await browser.close().catch(() => {});
  }
  return result;
}

// Labels each distinct version of the page text A, B, C… so you can see at a glance
// whether different locations were served different content.
function markContentVariants(results) {
  const hashes = [...new Set(results.filter((r) => r.page).map((r) => r.page.textHash))];
  if (hashes.length < 2) return false;
  for (const r of results) {
    if (r.page) r.page.variant = String.fromCharCode(65 + hashes.indexOf(r.page.textHash));
  }
  return true;
}

async function runJob(job, locations) {
  const outDir = store.reportDir(job.id);
  store.saveReport(job);

  for (let i = 0; i < locations.length; i++) {
    const base = job.results[i];
    job.results[i] = { ...base, status: 'running' };
    store.saveReport(job);

    const outcome = await checkLocation({ url: job.url, location: locations[i], settings: job.settings, outDir, index: i });
    job.results[i] = { ...base, ...outcome };
    store.saveReport(job);
  }

  job.contentDiffers = markContentVariants(job.results);
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  store.saveReport(job);
}

module.exports = { runJob };
