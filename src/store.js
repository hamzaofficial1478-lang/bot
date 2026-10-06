const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseProxy } = require('./proxy');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

fs.mkdirSync(REPORTS_DIR, { recursive: true });

const TARGETS = ['US', 'CA', 'EU', 'ANY'];

const DEFAULT_LOCATIONS = [
  { id: 'current', label: 'My current connection (VPN)', target: 'ANY', locale: 'en-US', proxy: '' },
];

function loadLocations() {
  try {
    return JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return DEFAULT_LOCATIONS.map((l) => ({ ...l }));
    throw new Error(`Couldn't read ${LOCATIONS_FILE}: ${err.message}`);
  }
}

function saveLocations(list) {
  fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(list, null, 2));
}

function cleanLocation(input = {}) {
  const label = String(input.label || '').trim().slice(0, 80);
  if (!label) throw new Error('Give the location a name, e.g. "USA – New York".');
  const target = TARGETS.includes(input.target) ? input.target : 'ANY';
  const locale = /^[a-z]{2}-[A-Z]{2}$/.test(input.locale) ? input.locale : 'en-US';
  const proxy = String(input.proxy || '').trim();
  parseProxy(proxy); // throws a readable error if the format is off
  return { label, target, locale, proxy };
}

function addLocation(input) {
  const list = loadLocations();
  const loc = { id: crypto.randomUUID(), ...cleanLocation(input) };
  list.push(loc);
  saveLocations(list);
  return loc;
}

function updateLocation(id, input) {
  const list = loadLocations();
  const i = list.findIndex((l) => l.id === id);
  if (i === -1) return null;
  list[i] = { id, ...cleanLocation(input) };
  saveLocations(list);
  return list[i];
}

function deleteLocation(id) {
  const list = loadLocations();
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) return false;
  saveLocations(next);
  return true;
}

function isReportId(id) {
  return /^[\w.-]+$/.test(id) && !id.includes('..');
}

function reportDir(id) {
  return path.join(REPORTS_DIR, id);
}

function saveReport(job) {
  fs.mkdirSync(reportDir(job.id), { recursive: true });
  fs.writeFileSync(path.join(reportDir(job.id), 'report.json'), JSON.stringify(job, null, 2));
}

function loadReport(id) {
  if (!isReportId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(reportDir(id), 'report.json'), 'utf8'));
  } catch {
    return null;
  }
}

// A check that was still running when the app last stopped is never going to finish.
function closeInterruptedReports() {
  for (const d of fs.readdirSync(REPORTS_DIR, { withFileTypes: true })) {
    const report = d.isDirectory() && loadReport(d.name);
    if (!report || report.status !== 'running') continue;
    report.status = 'interrupted';
    for (const r of report.results) {
      if (r.status === 'queued' || r.status === 'running') {
        r.status = 'failed';
        r.error = 'The app was stopped before this location was checked.';
      }
    }
    saveReport(report);
  }
}

function listReports() {
  return fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => loadReport(d.name))
    .filter(Boolean)
    .map(({ id, url, status, startedAt, results }) => ({
      id,
      url,
      status,
      startedAt,
      locations: results.length,
      failed: results.filter((r) => r.status === 'failed').length,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

module.exports = {
  REPORTS_DIR,
  loadLocations,
  addLocation,
  updateLocation,
  deleteLocation,
  reportDir,
  saveReport,
  loadReport,
  listReports,
  closeInterruptedReports,
};
