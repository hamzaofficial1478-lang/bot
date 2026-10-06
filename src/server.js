const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const store = require('./store');
const { maskProxy } = require('./proxy');
const { runJob } = require('./checker');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

// Only answer the dashboard itself. Locations can hold VPN commands that get run on this
// machine, so a web page you happen to visit must not be able to reach the API (CSRF / DNS rebinding).
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
app.use((req, res, next) => {
  const { host, origin } = req.headers;
  if (!OWN_HOSTS.includes(host) || (origin && !OWN_HOSTS.some((h) => origin === `http://${h}`))) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/reports', express.static(store.REPORTS_DIR));

let activeJob = null;
store.closeInterruptedReports();

// Scheduled re-checks: one full pass, then wait repeatMinutes, then another pass, until stopped.
// The floor keeps it a monitor (how the site behaves across the day), not a stream of visits.
const MIN_REPEAT_MINUTES = 15;
let schedule = null;

function stopSchedule() {
  if (schedule) clearTimeout(schedule.timer);
  schedule = null;
}

function startJob(url, locations, settings) {
  const job = {
    id: newJobId(url),
    url,
    status: 'running',
    startedAt: new Date().toISOString(),
    settings,
    // Only masked proxy details ever go into the job/report.
    results: locations.map((l) => ({
      locationId: l.id,
      label: l.label,
      target: l.target,
      locale: l.locale,
      proxy: maskProxy(l.proxy),
      status: 'queued',
    })),
  };

  activeJob = job;
  runJob(job, locations)
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      store.saveReport(job);
    })
    .finally(() => {
      if (!schedule) return;
      const ms = schedule.settings.repeatMinutes * 60000;
      schedule.nextRunAt = new Date(Date.now() + ms).toISOString();
      schedule.timer = setTimeout(() => {
        // Re-read locations each round so edits apply and deleted ones drop out.
        const next = store.loadLocations().filter((l) => schedule.ids.includes(l.id));
        if (!next.length) return stopSchedule();
        schedule.nextRunAt = null;
        startJob(schedule.url, next, schedule.settings);
      }, ms);
    });
  return job;
}

function normaliseUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Add your website link first.');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
    throw new Error("That doesn't look like a website address.");
  }
  return url.toString();
}

function newJobId(url) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-');
  return `${stamp}_${host}`;
}

function sendError(res, status, err) {
  res.status(status).json({ error: err.message || String(err) });
}

app.get('/api/locations', (req, res) => {
  res.json(store.loadLocations());
});

app.post('/api/locations', (req, res) => {
  try {
    res.status(201).json(store.addLocation(req.body));
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.put('/api/locations/:id', (req, res) => {
  try {
    const loc = store.updateLocation(req.params.id, req.body);
    if (!loc) return sendError(res, 404, new Error('Location not found.'));
    res.json(loc);
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.delete('/api/locations/:id', (req, res) => {
  if (!store.deleteLocation(req.params.id)) return sendError(res, 404, new Error('Location not found.'));
  res.status(204).end();
});

app.get('/api/checks', (req, res) => {
  res.json(store.listReports());
});

app.get('/api/checks/:id', (req, res) => {
  if (activeJob && activeJob.id === req.params.id) return res.json(activeJob);
  const report = store.loadReport(req.params.id);
  if (!report) return sendError(res, 404, new Error('Report not found.'));
  res.json(report);
});

app.get('/api/schedule', (req, res) => {
  res.json(schedule && { url: schedule.url, repeatMinutes: schedule.settings.repeatMinutes, nextRunAt: schedule.nextRunAt });
});

app.delete('/api/schedule', (req, res) => {
  stopSchedule();
  res.status(204).end();
});

app.post('/api/checks', (req, res) => {
  if (activeJob && activeJob.status === 'running') {
    return sendError(res, 409, new Error('A check is already running. Let it finish first.'));
  }

  let url;
  try {
    url = normaliseUrl(req.body.url);
  } catch (err) {
    return sendError(res, 400, err);
  }

  const ids = Array.isArray(req.body.locationIds) ? req.body.locationIds : [];
  const locations = store.loadLocations().filter((l) => ids.includes(l.id));
  if (!locations.length) return sendError(res, 400, new Error('Tick at least one location to check from.'));

  const seconds = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
  const repeat = seconds(req.body.repeatMinutes, 1440);
  const settings = {
    showBrowser: !!req.body.showBrowser,
    useChrome: !!req.body.useChrome,
    waitSeconds: seconds(req.body.waitSeconds, 15),
    gapSeconds: seconds(req.body.gapSeconds, 60),
    repeatMinutes: repeat && Math.max(MIN_REPEAT_MINUTES, repeat),
  };

  stopSchedule();
  if (settings.repeatMinutes) schedule = { url, ids, settings, nextRunAt: null, timer: null };
  const job = startJob(url, locations, settings);
  res.status(202).json(job);
});

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Site Geo Check is running at ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) openInBrowser(url);
});
