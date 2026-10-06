const $ = (id) => document.getElementById(id);

const TARGET_NAMES = { US: 'USA', CA: 'Canada', EU: 'Europe', ANY: 'Anywhere' };
const DEFAULT_LOCALE = { US: 'en-US', CA: 'en-CA', EU: 'en-GB', ANY: 'en-US' };

let locations = [];
let editingId = null;
let pollTimer = null;

// ---- small helpers -------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function remember(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function recall(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function fmtMs(ms) {
  if (ms == null) return '–';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtKb(kb) {
  if (kb == null) return '–';
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// Google's "good / needs improvement / poor" thresholds.
function grade(value, good, poor) {
  if (value == null) return '';
  if (value <= good) return 'good';
  return value <= poor ? 'warn' : 'bad';
}

// ---- locations -----------------------------------------------------------

function selectedIds() {
  return recall('selectedLocations', ['current']);
}

function renderLocations() {
  const selected = new Set(selectedIds());
  $('loc-list').innerHTML = locations.map((l) => `
    <li>
      <input type="checkbox" data-id="${esc(l.id)}" ${selected.has(l.id) ? 'checked' : ''} aria-label="Include ${esc(l.label)}">
      <div class="loc-main">
        <div class="name">${esc(l.label)}</div>
        <div class="meta">${esc(TARGET_NAMES[l.target])} · ${esc(l.locale)} · ${l.proxy ? `proxy ${esc(maskProxy(l.proxy))}` : 'current connection / VPN'}${l.vpnCommand ? ` · switches VPN: ${esc(l.vpnCommand)}` : ''}</div>
      </div>
      <button type="button" class="link" data-edit="${esc(l.id)}">Edit</button>
      <button type="button" class="link" data-delete="${esc(l.id)}">Delete</button>
    </li>`).join('') || '<li class="muted">No locations yet. Add one to get started.</li>';
}

function maskProxy(proxy) {
  return proxy.replace(/(\/\/[^:/@]+:)[^@]+@/, '$1***@').replace(/^([^:/]+:\d+:[^:]+:).+$/, '$1***');
}

async function loadLocations() {
  locations = await api('GET', '/api/locations');
  renderLocations();
}

function openLocationForm(loc) {
  editingId = loc ? loc.id : null;
  $('loc-form-title').textContent = loc ? 'Edit location' : 'Add location';
  $('loc-label').value = loc ? loc.label : '';
  $('loc-target').value = loc ? loc.target : 'US';
  $('loc-locale').value = loc ? loc.locale : 'en-US';
  $('loc-proxy').value = loc ? loc.proxy : '';
  $('loc-vpn').value = (loc && loc.vpnCommand) || '';
  showError($('loc-error'), '');
  $('loc-form').hidden = false;
  $('loc-label').focus();
}

$('add-loc-btn').addEventListener('click', () => openLocationForm(null));
$('loc-cancel').addEventListener('click', () => { $('loc-form').hidden = true; });

$('loc-target').addEventListener('change', (e) => {
  if (!editingId) $('loc-locale').value = DEFAULT_LOCALE[e.target.value];
});

$('loc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    label: $('loc-label').value,
    target: $('loc-target').value,
    locale: $('loc-locale').value,
    proxy: $('loc-proxy').value,
    vpnCommand: $('loc-vpn').value,
  };
  try {
    const saved = editingId
      ? await api('PUT', `/api/locations/${encodeURIComponent(editingId)}`, body)
      : await api('POST', '/api/locations', body);
    if (!editingId) remember('selectedLocations', [...selectedIds(), saved.id]);
    $('loc-form').hidden = true;
    await loadLocations();
  } catch (err) {
    showError($('loc-error'), err.message);
  }
});

$('loc-list').addEventListener('change', (e) => {
  if (!e.target.dataset.id) return;
  const ids = [...$('loc-list').querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id);
  remember('selectedLocations', ids);
});

$('loc-list').addEventListener('click', async (e) => {
  const editId = e.target.dataset.edit;
  const deleteId = e.target.dataset.delete;
  if (editId) openLocationForm(locations.find((l) => l.id === editId));
  if (deleteId) {
    const loc = locations.find((l) => l.id === deleteId);
    if (!confirm(`Delete "${loc.label}"?`)) return;
    await api('DELETE', `/api/locations/${encodeURIComponent(deleteId)}`);
    await loadLocations();
  }
});

// ---- running a check -----------------------------------------------------

$('url').value = recall('lastUrl', '');
$('show-browser').checked = recall('showBrowser', false);
$('use-chrome').checked = recall('useChrome', false);
$('wait-seconds').value = recall('waitSeconds', 6);
$('gap-seconds').value = recall('gapSeconds', 6);
$('repeat-minutes').value = recall('repeatMinutes', 0);

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('run-error'), '');
  const body = {
    url: $('url').value,
    locationIds: selectedIds().filter((id) => locations.some((l) => l.id === id)),
    showBrowser: $('show-browser').checked,
    useChrome: $('use-chrome').checked,
    waitSeconds: Number($('wait-seconds').value),
    gapSeconds: Number($('gap-seconds').value),
    repeatMinutes: Number($('repeat-minutes').value),
  };
  remember('lastUrl', body.url);
  remember('showBrowser', body.showBrowser);
  remember('useChrome', body.useChrome);
  remember('waitSeconds', body.waitSeconds);
  remember('gapSeconds', body.gapSeconds);
  remember('repeatMinutes', body.repeatMinutes);

  try {
    const job = await api('POST', '/api/checks', body);
    renderReport(job);
    poll(job.id);
    refreshSchedule();
  } catch (err) {
    showError($('run-error'), err.message);
  }
});

function poll(id) {
  clearTimeout(pollTimer);
  $('run-btn').disabled = true;
  pollTimer = setTimeout(async () => {
    try {
      const job = await api('GET', `/api/checks/${encodeURIComponent(id)}`);
      renderReport(job);
      if (job.status === 'running') return poll(id);
    } catch (err) {
      showError($('run-error'), err.message);
    }
    pollTimer = null;
    $('run-btn').disabled = false;
    loadHistory();
    refreshSchedule();
  }, 1200);
}

// Shows the repeat schedule and picks up each new round the server starts on its own.
async function refreshSchedule() {
  const s = await api('GET', '/api/schedule').catch(() => null);
  $('schedule-note').hidden = !s;
  if (!s) return;
  $('schedule-text').textContent = s.nextRunAt
    ? `Repeating every ${s.repeatMinutes} min. Next round at ${new Date(s.nextRunAt).toLocaleTimeString('en-GB')}.`
    : `Repeating every ${s.repeatMinutes} min. Round in progress.`;
  if (!s.nextRunAt && !pollTimer) {
    const running = (await loadHistory()).find((r) => r.status === 'running');
    if (running) poll(running.id);
  }
}

$('stop-repeat').addEventListener('click', async () => {
  await api('DELETE', '/api/schedule');
  refreshSchedule();
});

setInterval(refreshSchedule, 5000);

// ---- results -------------------------------------------------------------

function metric(label, value, cls) {
  return `<div class="metric ${cls}"><span>${label}</span><b>${value}</b></div>`;
}

function regionBadge(r) {
  if (!r.exit) return '<span class="badge warn">location unknown</span>';
  if (r.regionMatch === true) return `<span class="badge good">in ${esc(TARGET_NAMES[r.target])}</span>`;
  if (r.regionMatch === false) return `<span class="badge bad">expected ${esc(TARGET_NAMES[r.target])}</span>`;
  return '';
}

function statusBadge(r) {
  if (r.status === 'queued') return '<span class="badge">waiting</span>';
  if (r.status === 'running') return '<span class="badge warn">checking…</span>';
  if (r.status === 'failed') return '<span class="badge bad">failed</span>';
  if (r.page && r.page.challenge) return '<span class="badge bad">bot check shown</span>';
  if (r.httpStatus >= 400) return `<span class="badge bad">HTTP ${r.httpStatus}</span>`;
  return `<span class="badge good">HTTP ${r.httpStatus}</span>`;
}

function listDetails(title, items, fmt) {
  if (!items || !items.length) return '';
  return `<details><summary>${title} (${items.length})</summary><ul>${items.map((i) => `<li>${esc(fmt(i))}</li>`).join('')}</ul></details>`;
}

function renderResult(r, reportId) {
  const base = `/reports/${encodeURIComponent(reportId)}/`;
  const shots = r.screenshots || {};
  const shot = shots.top
    ? `<img class="shot" src="${base}${esc(shots.top)}" data-full="${base}${esc(shots.full || shots.top)}" alt="Screenshot from ${esc(r.label)}" loading="lazy">
       <div class="shot-links">${shots.full ? `<a class="muted" href="${base}${esc(shots.full)}" target="_blank" rel="noopener">Full page</a>` : ''}</div>`
    : `<div class="shot shot-empty">${r.status === 'running' ? 'Loading…' : 'No screenshot'}</div>`;

  const where = r.exit
    ? `${esc(r.exit.ip)} · ${esc([r.exit.city, r.exit.region, r.exit.country].filter(Boolean).join(', '))}${r.exit.isp ? ` · ${esc(r.exit.isp)}` : ''}`
    : (r.status === 'done' ? "Couldn't look up the IP's location" : '');

  let body = `<p class="line muted">${esc(r.proxy || 'Current connection / VPN')} · ${esc(r.locale)}</p>`;
  if (where) body += `<p class="line"><strong>Seen from:</strong> ${where} ${regionBadge(r)}</p>`;
  if (r.warning) body += `<p class="line note">${esc(r.warning)}</p>`;
  if (r.error) body += `<p class="line error">${esc(r.error)}</p>`;

  if (r.status === 'done') {
    const m = r.metrics || {};
    const n = r.network || {};
    const p = r.page || {};
    body += `<div class="metrics">
      ${metric('Server response', fmtMs(m.ttfbMs), grade(m.ttfbMs, 800, 1800))}
      ${metric('Largest paint', fmtMs(m.lcpMs), grade(m.lcpMs, 2500, 4000))}
      ${metric('Layout shift', m.cls ?? '–', grade(m.cls, 0.1, 0.25))}
      ${metric('DOM ready', fmtMs(m.domReadyMs), '')}
      ${metric('Fully loaded', fmtMs(m.loadMs), '')}
      ${metric('Requests', n.requests ?? '–', '')}
      ${metric('Downloaded', fmtKb(n.transferKb), '')}
    </div>`;
    if (r.finalUrl && r.finalUrl !== r.requestedUrl) {
      body += `<p class="line"><strong>Ended up on:</strong> ${esc(r.finalUrl)}${r.redirects && r.redirects.length ? ` (${r.redirects.length} redirect${r.redirects.length > 1 ? 's' : ''})` : ''}</p>`;
    }
    body += `<p class="line"><strong>Title:</strong> ${esc(p.title || '(none)')}${p.lang ? ` · lang="${esc(p.lang)}"` : ''}${p.variant ? ` · <span class="badge warn">content ${esc(p.variant)}</span>` : ''}</p>`;
    body += `<p class="line"><strong>Cookie banner:</strong> ${p.consentBanner ? 'shown' : 'not spotted'}`
      + `${p.currencies && p.currencies.length ? ` · <strong>Prices in:</strong> ${esc(p.currencies.join(', '))}` : ''}</p>`;
    const cdn = r.cdn || {};
    if (cdn.server || cdn.edge || cdn.cache) {
      body += `<p class="line"><strong>Served by:</strong> ${esc([cdn.server, cdn.edge && `edge ${cdn.edge}`, cdn.cache && `cache ${cdn.cache}`].filter(Boolean).join(' · '))}</p>`;
    }
    body += listDetails('Console errors', r.consoleErrors, (x) => x);
    body += listDetails('Failed requests', n.failed, (x) => `${x.reason} — ${x.url}`);
    body += listDetails('Error responses', n.badStatus, (x) => `${x.status} — ${x.url}`);
    body += listDetails('Redirects', r.redirects, (x) => x);
  }

  return `<article class="result">
    <div>${shot}</div>
    <div><h3>${esc(r.label)} ${statusBadge(r)}</h3>${body}</div>
  </article>`;
}

function renderReport(job) {
  $('results').hidden = false;
  const done = job.results.filter((r) => r.status === 'done' || r.status === 'failed').length;
  const when = new Date(job.finishedAt || job.startedAt).toLocaleString('en-GB');
  $('results-status').textContent = {
    running: `Checking ${Math.min(done + 1, job.results.length)} of ${job.results.length}…`,
    interrupted: `Stopped before it finished (${when})`,
    failed: `Something went wrong: ${job.error || 'unknown error'}`,
  }[job.status] || `Finished ${when}`;
  $('results-url').textContent = job.url;
  $('variant-note').hidden = !job.contentDiffers;
  $('result-list').innerHTML = job.results.map((r) => renderResult({ ...r, requestedUrl: job.url }, job.id)).join('');
}

$('result-list').addEventListener('click', (e) => {
  if (!e.target.classList.contains('shot') || !e.target.dataset.full) return;
  $('shot-img').src = e.target.dataset.full;
  $('shot-dialog').showModal();
});

// ---- history -------------------------------------------------------------

async function loadHistory() {
  const reports = await api('GET', '/api/checks');
  $('report-list').innerHTML = reports.map((r) => `
    <li data-report="${esc(r.id)}">
      <div class="loc-main">
        <div class="name">${esc(r.url)}</div>
        <div class="meta">${esc(new Date(r.startedAt).toLocaleString('en-GB'))} · ${r.locations} location${r.locations === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} failed` : ''}</div>
      </div>
      <span class="badge ${r.status === 'running' ? 'warn' : ''}">${r.status === 'running' ? 'running' : 'view'}</span>
    </li>`).join('') || '<li class="muted">Nothing yet. Your checks will show up here.</li>';
  return reports;
}

$('report-list').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-report]');
  if (!li) return;
  const job = await api('GET', `/api/checks/${encodeURIComponent(li.dataset.report)}`);
  renderReport(job);
  if (job.status === 'running') poll(job.id);
  $('results').scrollIntoView({ behavior: 'smooth' });
});

// ---- start up ------------------------------------------------------------

(async () => {
  await loadLocations();
  const reports = await loadHistory();
  const running = reports.find((r) => r.status === 'running');
  if (running) poll(running.id);
  refreshSchedule();
})();
