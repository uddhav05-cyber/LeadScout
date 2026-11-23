// LeadScout — popup controller (part 1: helpers, state, progress)

import { DEFAULT_SETTINGS, parseInputs, buildTSV, buildCSV, fmtEta } from './lib/parse.js';
import { extractLinkedInCompany } from './lib/extract.js';

import { researchSummary } from './lib/research-diagnostics.js';

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } };
let job = null;
const ui = { filter: 'all', search: '', pollTimer: null };

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'no response' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes());
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function loadState() {
  const st = await chrome.storage.local.get(['settings', 'job']);
  if (st.settings) {
    settings = { ...DEFAULT_SETTINGS, ...st.settings,
      keys: { ...DEFAULT_SETTINGS.keys, ...(st.settings.keys || {}) } };
  }
  job = st.job || null;
}

function startPolling() {
  if (ui.pollTimer) return;
  ui.pollTimer = setInterval(refresh, 800);
}

function stopPolling() {
  if (ui.pollTimer) { clearInterval(ui.pollTimer); ui.pollTimer = null; }
}

async function refresh() {
  const st = await chrome.storage.local.get(['job']);
  job = st.job || job;
  renderProgress();
  renderResults(false);
  if (!job || (!job.running && !job.paused)) stopPolling();
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || 'dark';
}

function updateInputCount() {
  const items = parseInputs($('companyInput').value);
  $('inputCount').textContent = items.length +
    (items.length === 1 ? ' company' : ' companies');
  return items;
}

function currentProviderKeyReady() {
  const prov = $('optProvider').value;
  if (prov === 'none') return { ready: true };
  const key = (settings.keys && settings.keys[prov]) || '';
  if (key) return { ready: true };
  if (prov === 'custom' && settings.customBase) return { ready: true };
  return {
    ready: false,
    hint: 'No ' + prov + ' API key saved yet — add one in Settings (gear icon), or pick "None (Bing only)".'
  };
}

// ---------------------------------------------------- progress rendering ----

function renderProgress() {
  if (!job) return;
  const hasActivity = job.running || job.paused || (job.queue && job.queue.length);
  const card = $('cardProgress');
  card.classList.toggle('hidden', !hasActivity);
  if (!hasActivity) return;

  const total = job.queue ? job.queue.length : 0;
  const done = (job.queue || []).filter(q => q.status === 'done' || q.status === 'failed').length;
  $('progCount').textContent = done + ' / ' + total;
  $('progBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';

  let label = 'Idle';
  if (job.attention) label = 'Needs attention';
  else if (job.paused) label = 'Paused';
  else if (job.running) {
    const cur = (job.queue || [])[job.cursor];
    label = cur && cur.status === 'working'
      ? ('Researching: ' + (cur.name || cur.input))
      : 'Working…';
  } else if (job.finishedAt) label = 'Finished';
  $('progLabel').textContent = label;

  const remaining = Math.max(0, total - done);
  const etaSec = job.perCompanyMs ? (remaining * job.perCompanyMs) / 1000 : 0;
  $('progEta').textContent = (job.running && remaining > 0)
    ? ('ETA ' + fmtEta(etaSec)) : 'ETA —';

  // live stat tiles
  let peopleN = 0, verifiedN = 0;
  for (const c of (job.results || [])) {
    for (const p of (c.people || [])) {
      peopleN++;
      if (p.urlVerified) verifiedN++;
    }
  }
  $('statPeople').textContent = String(peopleN);
  $('statVerified').textContent = String(verifiedN);
  $('statCompanies').textContent = String(done);
  $('statRemaining').textContent = String(remaining);

  const banner = $('attentionBanner');
  if (job.attention) {
    banner.textContent = '⚠ ' + job.attention;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const doneB = $('doneBanner');
  if (!job.running && !job.paused && job.finishedAt && total > 0) {
    doneB.textContent = '✓ Finished — ' + done + ' of ' + total +
      ' companies · ' + peopleN + ' people (' + verifiedN + ' verified). Export below.';
    doneB.classList.remove('hidden');
  } else {
    doneB.classList.add('hidden');
  }

  renderQueueChips();
  syncProgressButtons();
}

function renderQueueChips() {
  const ql = $('queueList');
  const queue = (job && job.queue) || [];
  if (!queue.length) { ql.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  for (const q of queue) {
    const el = document.createElement('span');
    el.className = 'q-item ' + (q.status || 'queued');
    let txt = (q.name || q.input || '').slice(0, 26);
    if (q.status === 'done') txt += ' ✓';
    if (q.status === 'failed') txt += ' ✗';
    el.textContent = txt;
    el.title = (q.name || q.input || '') + (q.error ? ' — ' + q.error : '');
    frag.appendChild(el);
  }
  ql.replaceChildren(frag);
}

function syncProgressButtons() {
  const running = !!(job && job.running);
  const paused = !!(job && job.paused);
  $('btnPause').classList.toggle('hidden', !running || paused);
  $('btnResume').classList.toggle('hidden', !paused);
  $('btnStop').classList.toggle('hidden', !running && !paused);
  const failed = !!(job && job.queue && job.queue.some(q => q.status === 'failed'));
  $('btnRetryFailed').classList.toggle('hidden', !(failed && !running && !paused));
  // v1.4: fresh-data re-run of everything already researched
  const doneN = job && job.queue ? job.queue.filter(q => q.status === 'done').length : 0;
  $('btnRefreshAll').classList.toggle('hidden', !(doneN > 0 && !running && !paused));
}

// ----------------------------------------------------- results rendering ----

function flattenRows() {
  const rows = [];
  if (!job || !job.results) return rows;
  for (const comp of job.results) {
    const people = [...(comp.people || [])].sort((a, b) =>
      (a.pri || 9) - (b.pri || 9) || (b.score || 0) - (a.score || 0));
    if (!people.length) {
      rows.push({ comp: comp, p: null, kind: 'review' });
      continue;
    }
    for (const p of people) rows.push({ comp: comp, p: p, kind: 'person' });
  }
  return rows;
}

function rowMatches(r, filter, search) {
  const cat = r.p ? r.p.cat : 'review';
  if (filter === 'unverified') {
    if (r.kind !== 'person') return false;
    if (r.p.urlVerified) return false;
  } else if (filter === 'review') {
    if (r.kind !== 'review') return false;
  } else if (filter !== 'all') {
    if (r.kind !== 'person' || cat !== filter) return false;
  }
  if (search) {
    const hay = ((r.p ? r.p.name + ' ' + r.p.designation : '') +
      ' ' + r.comp.name + ' ' + r.comp.industry).toLowerCase();
    if (hay.indexOf(search.toLowerCase()) === -1) return false;
  }
  return true;
}

function pillEl(cls, txt) {
  const s = document.createElement('span');
  s.className = 'pill ' + cls;
  s.textContent = txt;
  return s;
}

function linkEl(href, txt) {
  // v1.4 security: only real web links become anchors — never javascript:/data:
  if (!/^https?:\/\//i.test(String(href || ''))) {
    return document.createTextNode(txt);
  }
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = txt;
  return a;
}

function tdText(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

// v1.4 lag fix: the table is expensive to rebuild — only re-render when the
// underlying data actually changed (poll runs every 800 ms).
let lastResultsKey = '';

function renderResults(force) {
  if (!job) return;
  const hasResults = !!(job.results && job.results.length);
  $('cardResults').classList.toggle('hidden', !hasResults);
  if (!hasResults) { lastResultsKey = ''; return; }

  let doneN = 0, peopleN = 0;
  for (const c of job.results) {
    if (c.status === 'done' || c.status === 'failed') doneN++;
    peopleN += (c.people || []).length;
  }
  const key = (job.results || []).length + '|' + (job.cursor || 0) + '|' + doneN + '|' + peopleN + '|' + (job.finishedAt || 0);
  if (!force && key === lastResultsKey) return;
  lastResultsKey = key;

  const rows = flattenRows();
  const peopleCount = rows.filter(r => r.kind === 'person').length;
  const verifiedCount = rows.filter(r => r.kind === 'person' && r.p.urlVerified).length;
  $('resSummary').textContent = peopleCount + ' people · ' + verifiedCount + ' verified';

  const visible = rows.filter(r => rowMatches(r, ui.filter, ui.search)).slice(0, 300);
  const tbody = $('resBody');
  const frag = document.createDocumentFragment();
  for (const r of visible) {
    const tr = document.createElement('tr');

    if (r.kind === 'review') {
      tr.appendChild(tdText('—', 'ds'));
      tr.appendChild(tdText(researchSummary(r.comp), 'ds research-diagnostics'));
      tr.appendChild(tdText(r.comp.name || r.comp.input, 'co'));
      const tdL = document.createElement('td');
      if (r.comp.url) tdL.appendChild(linkEl(r.comp.url, 'page'));
      else tdL.appendChild(document.createTextNode('—'));
      tr.appendChild(tdL);
      const tdF = document.createElement('td');
      tdF.appendChild(pillEl('u', 'REVIEW'));
      tr.appendChild(tdF);
      frag.appendChild(tr);
      continue;
    }

    const p = r.p;
    tr.appendChild(tdText(p.name, 'nm'));

    const tdD = document.createElement('td');
    tdD.className = 'ds';
    const desigDiv = document.createElement('div');
    desigDiv.textContent = p.designation || '';
    tdD.appendChild(desigDiv);
    if (p.email) {
      const mailDiv = document.createElement('div');
      mailDiv.className = 'est-mail';
      mailDiv.title = 'estimated from company domain — unverified';
      mailDiv.textContent = '✉ ' + p.email;
      tdD.appendChild(mailDiv);
    }
    tr.appendChild(tdD);

    tr.appendChild(tdText(r.comp.name || r.comp.input, 'co'));

    const tdL = document.createElement('td');
    if (p.url) tdL.appendChild(linkEl(p.url, 'profile'));
    else tdL.appendChild(document.createTextNode('—'));
    tr.appendChild(tdL);

    const tdF = document.createElement('td');
    tdF.appendChild(pillEl('p' + (p.pri || 5), p.priority || 'P5'));
    tdF.appendChild(document.createTextNode(' '));
    tdF.appendChild(pillEl(p.urlVerified ? 'v' : 'u', p.urlVerified ? 'VERIFIED' : 'UNVERIFIED'));
    if (p.currentEmployer) {
      tdF.appendChild(document.createTextNode(' '));
      const roleCls = p.currentEmployer === 'current' ? 'v' :
        (p.currentEmployer === 'snippet' ? 'est' : 'u');
      const roleTxt = p.currentEmployer === 'current' ? 'CURRENT' :
        (p.currentEmployer === 'snippet' ? 'SNIPPET' : 'PAST?');
      const rolePill = pillEl(roleCls, roleTxt);
      rolePill.title = p.currentEmployer === 'current'
        ? 'Role at this company is title-verified (current)'
        : p.currentEmployer === 'snippet'
          ? 'Company seen in the search snippet, no past-role markers'
          : 'Contradictory signals — may be a past role, verify manually';
      tdF.appendChild(rolePill);
    }
    tr.appendChild(tdF);

    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

// -------------------------------------------------------------- actions ----

async function doStart() {
  const items = updateInputCount();
  if (!items.length) {
    toast('Paste at least one LinkedIn URL or company name');
    return;
  }
  const prov = $('optProvider').value;
  const keyCheck = currentProviderKeyReady();
  if (!keyCheck.ready) {
    toast(keyCheck.hint, 3200);
    return;
  }

  settings.scanMode = $('optMode').value;
  settings.provider = prov;
  settings.deepScan = $('optDeepScan').checked;
  settings.includeEmails = $('optEmails').checked;
  await sendMsg({ type: 'setSettings', settings: settings });

  const res = await sendMsg({ type: 'start', items: items });
  if (!res.ok) {
    toast('Start failed: ' + String(res.error || 'unknown'), 3200);
    return;
  }
  toast('Researching ' + res.count + ' companies…');
  await loadState();
  renderProgress();
  renderResults(true);
  startPolling();
}

async function doPause() {
  await sendMsg({ type: 'pause' });
  await loadState();
  renderProgress();
  syncProgressButtons();
}

async function doResume() {
  await sendMsg({ type: 'resume' });
  await loadState();
  renderProgress();
  syncProgressButtons();
  startPolling();
}

async function doStop() {
  await sendMsg({ type: 'stop' });
  await loadState();
  renderProgress();
  syncProgressButtons();
}

async function doRetryFailed() {
  if (!job || !job.queue) return;
  const failed = job.queue.filter(q => q.status === 'failed');
  if (!failed.length) return;
  const requeued = failed.map(q => ({
    type: q.type, slug: q.slug, name: q.name, input: q.input,
    status: 'queued', error: ''
  }));
  await sendMsg({ type: 'start', items: requeued });
  toast('Retrying ' + requeued.length + ' failed companies');
  await loadState();
  startPolling();
}

// v1.4: re-run every researched company so names, roles, facts and emails
// reflect the latest public data (results entries are updated in place).
async function doRefreshAll() {
  if (!job || !job.queue) return;
  const done = job.queue.filter(q => q.status === 'done');
  if (!done.length) return;
  const requeued = done.map(q => ({
    type: q.type, slug: q.slug, name: q.name, input: q.input,
    status: 'queued', error: ''
  }));
  await sendMsg({ type: 'start', items: requeued });
  toast('Refreshing ' + requeued.length + ' companies with latest data…');
  await loadState();
  startPolling();
}

async function doClearResults() {
  await sendMsg({ type: 'clearResults' });
  await loadState();
  renderProgress();
  renderResults(true);
  toast('Results cleared');
}

async function doAddCurrent() {
  const res = await sendMsg({ type: 'addCurrentPage' });
  if (!res.ok) {
    toast(res.error || 'Could not read the current tab', 2600);
    return;
  }
  const ta = $('companyInput');
  const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.indexOf(res.line) !== -1) {
    toast('Already in the list');
    return;
  }
  ta.value = lines.concat([res.line]).join('\n');
  updateInputCount();
  toast('Added current company');
}

function doSample() {
  $('companyInput').value =
    'https://www.linkedin.com/company/zoho/\n' +
    'Freshworks\n' +
    'Postman - https://www.linkedin.com/company/postman-platform/';
  updateInputCount();
}

// -------------------------------------------------------------- exports ----

function exportTargets() {
  return ((job && job.results) || []).filter(c => c.status === 'done');
}

/**
 * v1.3 one-click exports: when a filter chip or search is active, export ONLY
 * the visible rows (grouped back by company). Otherwise export everything.
 */
function filteredExportComps() {
  const comps = exportTargets();
  const filtering = (ui.filter !== 'all') || !!ui.search;
  if (!filtering) return comps;
  const rows = flattenRows().filter(r => rowMatches(r, ui.filter, ui.search));
  const map = new Map();
  for (const r of rows) {
    const c = map.get(r.comp.id);
    if (c) {
      if (r.kind === 'person') c.people.push(r.p);
      else c.hasReview = true;
    } else {
      map.set(r.comp.id, {
        id: r.comp.id,
        input: r.comp.input,
        url: r.comp.url,
        name: r.comp.name,
        industry: r.comp.industry,
        size: r.comp.size,
        hq: r.comp.hq,
        country: r.comp.country,
        people: r.kind === 'person' ? [r.p] : [],
        hasReview: r.kind !== 'person'
      });
    }
  }
  const out = [];
  for (const c of map.values()) {
    if (c.people.length || c.hasReview) out.push(c);
  }
  return out;
}

async function doCopy(core) {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet'); return; }
  const tsv = buildTSV(comps, { core: core });
  try {
    await navigator.clipboard.writeText(tsv);
    toast('Copied ' + (core ? 'core' : 'full') + ' TSV — paste straight into Excel');
  } catch (e) {
    toast('Clipboard blocked — use the .TSV download instead');
  }
}

function doDownload(kind) {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet'); return; }
  if (kind === 'tsv') {
    download('leadscout-' + stamp() + '.tsv',
      buildTSV(comps, { core: false }),
      'text/tab-separated-values;charset=utf-8');
  } else {
    download('leadscout-' + stamp() + '.csv',
      '\uFEFF' + buildCSV(comps, { core: false }),
      'text/csv;charset=utf-8');
  }
  toast('Downloaded');
}

// ------------------------------------------------------------- settings ----

function openSettings() {
  $('setProvider').value = settings.provider || 'groq';
  $('setKeyGroq').value = (settings.keys && settings.keys.groq) || '';
  $('setKeyGemini').value = (settings.keys && settings.keys.gemini) || '';
  $('setKeyOpenrouter').value = (settings.keys && settings.keys.openrouter) || '';
  $('setKeyHunter').value = (settings.keys && settings.keys.hunter) || '';
  const models = settings.models || {};
  $('setModelGroq').value = models.groq || '';
  $('setModelGemini').value = models.gemini || '';
  $('setModelOpenrouter').value = models.openrouter || '';
  $('setCustomBase').value = settings.customBase || '';
  $('setCustomModel').value = settings.customModel || '';
  $('setDelay').value = settings.bingDelayMs || 2200;
  $('delayVal').textContent = (settings.bingDelayMs || 2200) + ' ms';
  $('setHost').value = settings.searchHost || 'www.bing.com';
  $('setTheme').value = settings.theme || 'dark';
  $('customFields').classList.toggle('hidden', $('setProvider').value !== 'custom');
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  $('settingsModal').classList.remove('hidden');
}

function readSettingsForm() {
  return {
    ...settings,
    provider: $('setProvider').value,
    keys: {
      groq: $('setKeyGroq').value.trim(),
      gemini: $('setKeyGemini').value.trim(),
      openrouter: $('setKeyOpenrouter').value.trim(),
      hunter: $('setKeyHunter').value.trim(),
      custom: ''
    },
    models: {
      groq: $('setModelGroq').value.trim(),
      gemini: $('setModelGemini').value.trim(),
      openrouter: $('setModelOpenrouter').value.trim(),
      custom: ''
    },
    customBase: $('setCustomBase').value.trim(),
    customModel: $('setCustomModel').value.trim(),
    bingDelayMs: Number($('setDelay').value) || 2200,
    searchHost: $('setHost').value,
    theme: $('setTheme').value
  };
}

async function saveSettings() {
  const next = readSettingsForm();
  if (next.provider === 'custom' && next.customBase) {
    try {
      const origin = new URL(next.customBase).origin + '/*';
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        toast('Permission denied for custom endpoint', 3000);
        return;
      }
    } catch (e) {
      toast('Invalid custom base URL', 3000);
      return;
    }
  }

  const res = await sendMsg({ type: 'setSettings', settings: next });
  if (!res.ok) {
    toast('Save failed: ' + String(res.error || 'unknown'), 3000);
    return;
  }
  settings = next;
  $('optProvider').value = next.provider;
  applyTheme();
  $('settingsModal').classList.add('hidden');
  toast('Settings saved');
}

async function testKey() {
  const el = $('testResult');
  el.textContent = 'Testing…';
  el.className = 'test-result';
  const draft = readSettingsForm();
  const res = await sendMsg({ type: 'testAI', provider: draft.provider, settings: draft });
  if (res.ok) {
    el.textContent = '✓ ' + res.message;
    el.classList.add('ok');
  } else {
    el.textContent = '✗ ' + String(res.error || 'failed');
    el.classList.add('err');
  }
}

// ----------------------------------------------------------------- wire ----

function wire() {
  $('companyInput').addEventListener('input', updateInputCount);
  $('btnStart').addEventListener('click', doStart);
  $('btnAddCurrent').addEventListener('click', doAddCurrent);
  $('btnSample').addEventListener('click', doSample);
  $('btnClearInput').addEventListener('click', () => {
    $('companyInput').value = '';
    updateInputCount();
  });

  $('btnPause').addEventListener('click', doPause);
  $('btnResume').addEventListener('click', doResume);
  $('btnStop').addEventListener('click', doStop);
  $('btnRetryFailed').addEventListener('click', doRetryFailed);
  $('btnRefreshAll').addEventListener('click', doRefreshAll);

  $('filterRow').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const chips = $('filterRow').children;
    for (const c of chips) c.classList.remove('active');
    chip.classList.add('active');
    ui.filter = chip.dataset.f;
    renderResults(true);
  });
  $('resSearch').addEventListener('input', () => {
    ui.search = $('resSearch').value.trim();
    renderResults(true);
  });

  $('btnCopyTsv').addEventListener('click', () => doCopy(false));
  $('btnCopyCore').addEventListener('click', () => doCopy(true));
  $('btnDlTsv').addEventListener('click', () => doDownload('tsv'));
  $('btnDlCsv').addEventListener('click', () => doDownload('csv'));
  $('btnOpenFull').addEventListener('click', () => chrome.tabs.create({ url: 'results.html' }));
  $('btnClearResults').addEventListener('click', doClearResults);

  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestKey').addEventListener('click', testKey);
  $('setProvider').addEventListener('change', () => {
    $('customFields').classList.toggle('hidden', $('setProvider').value !== 'custom');
  });
  $('setDelay').addEventListener('input', () => {
    $('delayVal').textContent = $('setDelay').value + ' ms';
  });
  $('setTheme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('setTheme').value;
  });
  $('btnTheme').addEventListener('click', toggleTheme);

  $('settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('settingsModal')) {
      $('settingsModal').classList.add('hidden');
    }
  });
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  settings.theme = next;
  await sendMsg({ type: 'setSettings', settings: settings });
}

async function init() {
  await loadState();
  applyTheme();
  $('optMode').value = settings.scanMode || 'standard';
  $('optProvider').value = settings.provider || 'groq';
  $('optDeepScan').checked = settings.deepScan !== false;
  $('optEmails').checked = settings.includeEmails !== false;
  updateInputCount();
  renderProgress();
  renderResults(true);
  wire();
  if (job && (job.running || job.paused)) startPolling();
}

document.addEventListener('DOMContentLoaded', init);
