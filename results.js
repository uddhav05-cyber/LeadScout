// LeadScout — full-page results view

import { DEFAULT_SETTINGS, buildTSV, buildCSV, fmtEta } from './lib/parse.js';

import { researchSummary } from './lib/research-diagnostics.js';

const $ = (id) => document.getElementById(id);

let job = null;
const ui = { filter: 'all', search: '' };

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
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

// theme lives in settings; keep the page consistent with the popup
(async () => {
  const st = await chrome.storage.local.get(['settings']);
  const theme = (st.settings && st.settings.theme) || 'dark';
  document.documentElement.dataset.theme = theme;
})();

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

function tdText(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
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

// v1.4 lag fix: rebuild the table only when data actually changed
let lastKey = '';

function render(force) {
  if (!job) { $('resBody').replaceChildren(); lastKey = ''; return; }
  let doneN = 0, peopleN = 0;
  for (const c of (job.results || [])) {
    if (c.status === 'done' || c.status === 'failed') doneN++;
    peopleN += (c.people || []).length;
  }
  const key = (job.results || []).length + '|' + (job.cursor || 0) + '|' + doneN + '|' + peopleN + '|' + (job.running ? 'r' : '') + (job.paused ? 'p' : '') + (job.finishedAt || 0);
  if (!force && key === lastKey) return;
  lastKey = key;

  const rows = flattenRows();
  const peopleCount = rows.filter(r => r.kind === 'person').length;
  const verifiedCount = rows.filter(r => r.kind === 'person' && r.p.urlVerified).length;
  const compCount = (job.results || []).length;
  let status = '';
  if (job.running) status = ' · running…';
  else if (job.paused) status = ' · paused';
  $('resSummary').textContent =
    peopleCount + ' people · ' + verifiedCount + ' verified · ' +
    compCount + ' companies' + status;

  const visible = rows.filter(r => rowMatches(r, ui.filter, ui.search));
  const capped = visible.slice(0, 2000);
  const frag = document.createDocumentFragment();

  for (const r of capped) {
    const tr = document.createElement('tr');

    if (r.kind === 'review') {
      tr.appendChild(tdText('—', 'ds'));
      tr.appendChild(tdText(researchSummary(r.comp), 'ds research-diagnostics'));
      tr.appendChild(tdText(r.comp.country || '', 'ds'));
      tr.appendChild(tdText(r.comp.name || r.comp.input, 'co'));
      tr.appendChild(tdText(displaySize(r.comp), 'ds'));
      tr.appendChild(tdText(r.comp.industry || '', 'ds'));
      tr.appendChild(tdText('—'));
      tr.appendChild(companyPageCell(r.comp));
      tr.appendChild(tdText('', ''));
      const tdF = document.createElement('td');
      tdF.appendChild(pillEl('u', r.comp.status === 'working' ? 'RUNNING' : 'REVIEW'));
      if (!job.running && !job.paused) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn ghost small';
        retry.textContent = r.comp.url ? 'Retry' : 'Retry with URL';
        retry.addEventListener('click', () => retryCompany(r.comp, retry));
        tdF.appendChild(retry);
      }
      tr.appendChild(tdF);
      frag.appendChild(tr);
      continue;
    }

    const p = r.p;
    const c = r.comp;
    tr.appendChild(tdText(p.name, 'nm'));

    const tdD = document.createElement('td');
    tdD.className = 'ds';
    const desigDiv = document.createElement('div');
    desigDiv.textContent = p.designation || '';
    tdD.appendChild(desigDiv);
    tr.appendChild(tdD);

    tr.appendChild(tdText(c.country || '', 'ds'));
    tr.appendChild(tdText(c.name || c.input, 'co'));
    tr.appendChild(tdText(displaySize(c), 'ds'));
    tr.appendChild(tdText(c.industry || '', 'ds'));

    const tdL = document.createElement('td');
    if (p.url) tdL.appendChild(linkEl(p.url, 'profile'));
    else tdL.appendChild(document.createTextNode('—'));
    tr.appendChild(tdL);
    tr.appendChild(companyPageCell(c));

    const tdE = document.createElement('td');
    tdE.className = 'est-mail';
    if (p.email) {
      tdE.textContent = p.email;
      tdE.title = 'estimated from company domain — unverified' +
        (p.emailStatus ? ' (' + p.emailStatus + ')' : '');
    } else {
      tdE.textContent = '—';
    }
    tr.appendChild(tdE);

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

  $('resBody').replaceChildren(frag);
  $('truncateNote').textContent = visible.length > capped.length
    ? ('Showing ' + capped.length + ' of ' + visible.length + ' rows — refine filters or export for the full set.')
    : '';
}

function displaySize(company) {
  return company.sizeSource ? company.size : (company.size ? 'Unverified' : '');
}

function companyPageCell(company) {
  const td = document.createElement('td');
  if (company.url) td.appendChild(linkEl(company.url, 'Company page'));
  else td.textContent = '—';
  return td;
}

async function retryCompany(company, button) {
  const url = company.url ? '' : window.prompt('Enter the direct LinkedIn company URL for ' +
    (company.name || company.input));
  if (url === null || (!company.url && !url.trim())) return;
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'retryCompany', id: company.id, url: url.trim() });
    if (!response?.ok) throw new Error(response?.error || 'The extension could not start the retry.');
    toast('Company queued');
  } catch (error) {
    toast(error.message, 3500);
  } finally {
    button.disabled = false;
  }
}

function exportTargets() {
  return ((job && job.results) || []).filter(c => c.status === 'done');
}

async function doCopy(core) {
  const comps = exportTargets();
  if (!comps.length) { toast('No results yet'); return; }
  try {
    await navigator.clipboard.writeText(buildTSV(comps, { core: core }));
    toast('Copied ' + (core ? 'core' : 'full') + ' TSV — paste straight into Excel');
  } catch (e) {
    toast('Clipboard blocked — use the .TSV download instead');
  }
}

function doDownload(kind) {
  const comps = exportTargets();
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

function wire() {
  $('filterRow').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const chips = $('filterRow').children;
    for (const c of chips) c.classList.remove('active');
    chip.classList.add('active');
    ui.filter = chip.dataset.f;
    render(true);
  });
  $('resSearch').addEventListener('input', () => {
    ui.search = $('resSearch').value.trim();
    render(true);
  });
  $('btnCopyTsv').addEventListener('click', () => doCopy(false));
  $('btnCopyCore').addEventListener('click', () => doCopy(true));
  $('btnDlTsv').addEventListener('click', () => doDownload('tsv'));
  $('btnDlCsv').addEventListener('click', () => doDownload('csv'));
}

async function init() {
  const st = await chrome.storage.local.get(['job']);
  job = st.job || null;
  render();
  wire();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.job) return;
    job = changes.job.newValue || null;
    render();
  });
}

document.addEventListener('DOMContentLoaded', init);
