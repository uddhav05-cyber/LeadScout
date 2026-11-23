// LeadScout — background orchestrator (MV3 service worker, ES module).
//
// Pipeline per company (each company is researched in FULL isolation — this is
// what prevents the "bulk paste gives wrong details" problem):
//   1. resolve company slug (Bing)            [only for plain names]
//   2. read the LinkedIn company page         [deepScan, verified facts]
//   3. run scoped Bing queries for profiles   [site:linkedin.com/in "Company"]
//   4. optional AI enrichment (Groq/Gemini)   [corpus-restricted, no invention]
//   5. rank, dedupe, flag verification, estimate emails
//
// All browsing happens in real hidden tabs with the user's own session, with
// human-like pacing; captcha walls pause the queue for manual handling.

import { DEFAULT_SETTINGS, PROVIDERS } from './lib/parse.js';
import {
  slugFromUrl, titleCaseSlug, decodeBingUrl, parseProfileTitle, linkedinHandle,
  isLinkedInProfile, companyMatch, companyMatchPartial, emailFor, domainFromWebsite,
  overlapTokens, kebabName, slugScore, looseResolveMatch,
  roleCurrency, matchHunterEmail, cell
} from './lib/parse.js';
import { classifyDesignation, seniorityBonus } from './lib/rank.js';
import { aiResearch, aiTestKey } from './lib/ai.js';
import { hunterDomainSearch } from './lib/hunter.js';
import { extractBingResults, extractLinkedInCompany } from './lib/extract.js';

// ------------------------------------------------------------ app state ----

let SETTINGS = { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } };
const S = {
  job: {
    running: false, paused: false, cursor: 0, queue: [], results: [],
    startedAt: null, finishedAt: null, attention: null, perCompanyMs: 0, doneCount: 0
  },
  busy: false,
  runId: 0,
  tabBing: null,
  tabLI: null,
  lastActiveTab: null,
  heartbeat: null
};

function persist() {
  return chrome.storage.local.set({ job: S.job });
}
async function loadAll() {
  const st = await chrome.storage.local.get(['settings', 'job']);
  if (st.settings) SETTINGS = { ...DEFAULT_SETTINGS, ...st.settings, keys: { ...DEFAULT_SETTINGS.keys, ...(st.settings.keys || {}) } };
  if (st.job) S.job = { ...S.job, ...st.job };
}
async function saveSettings() {
  await chrome.storage.local.set({ settings: SETTINGS });
}

function setBadge() {
  try {
    if (S.job.running) {
      const remaining = Math.max(0, S.job.queue.length - S.job.cursor);
      chrome.action.setBadgeText({ text: String(remaining) });
      chrome.action.setBadgeBackgroundColor({ color: '#6D28D9' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* ignore */ }
}

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic', iconUrl: 'icons/icon48.png', title, message
    });
  } catch (e) { /* ignore */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Human-like pacing jitter (NOT cryptographic — timing only), still uses CSPRNG for cleanliness.
function jitter(base) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const factor = 0.75 + (arr[0] / 4294967296) * 0.6; // 0.75 – 1.35
  return Math.max(400, Math.round(base * factor));
}

// ------------------------------------------------------- worker-tab utils ----

async function ensureTab(which, url) {
  let tabId = which === 'bing' ? S.tabBing : S.tabLI;
  const wants = url;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && !tab.id) throw new Error('no tab');
  } catch (e) {
    const created = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = created.id;
    if (which === 'bing') S.tabBing = tabId; else S.tabLI = tabId;
  }
  await chrome.tabs.update(tabId, { url: wants });
  return tabId;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { throw new Error('Tab was closed'); }
    if (tab.status === 'complete') { await sleep(450); return; } // settle for late-rendered DOM
    await sleep(300);
  }
  // timeout — proceed anyway; the extractor will tell us what it sees
}

// ----------------------------------------------- injected page extractors ----
// Defined in lib/extract.js and imported above — the SAME functions are used
// by the popup for "Add current page", so behaviour is identical everywhere.

// ------------------------------------------------------------ search I/O ----

async function bingSearch(query, stats) {
  const host = SETTINGS.searchHost || 'www.bing.com';
  const url = 'https://' + host + '/search?q=' + encodeURIComponent(query) + '&count=30';
  const tabId = await ensureTab('bing', url);
  await waitForTabLoad(tabId, 22000);
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractBingResults });
      res = frames && frames[0] && frames[0].result;
    } catch (e) {
      await sleep(1200);
      continue;
    }
    if (res && res.captcha) break;
    if (res && res.consent && attempt < 2) {
      await sleep(2600);   // first-run/region redirect — give it a beat, re-read
      continue;
    }
    if (res && res.results && res.results.length) break;
    await sleep(1400); // late render — try once more
  }
  if (res?.captcha) stats.verification++;
  else if (res?.consent && !res.results?.length) stats.consent++;
  else if (!res || (!res.results?.length && !res.noResults)) stats.unreadable++;
  if (!res) res = { results: [], captcha: false, noResults: false, title: '' };
  if (res.captcha) {
    S.job.paused = true;
    S.job.attention = 'Bing is asking for human verification. Open any Bing search tab, complete the check, then click Resume.';
    await persist();
    notify('ls-captcha', 'LeadScout paused', 'Bing needs human verification — complete it, then Resume in LeadScout.');
    throw new Error('Bing captcha — queue paused');
  }
  const results = (res.results || []).map(r => ({ ...r, url: decodeBingUrl(r.url) }));
  stats.results += results.length;
  // v1.4: skip the trailing pacing delay when the queue stopped (no wasted lag)
  if (S.job.running && !S.job.paused) {
    await sleep(jitter(SETTINGS.bingDelayMs || 2200));
  }
  return results;
}

async function readLinkedInCompany(slug) {
  // v1.1: the /about/ page carries ALL company facts (industry, size, HQ,
  // website) — the base page is heavily authwalled for guests and often omits
  // them. Try /about/ first, then the base page; re-extract to ride out
  // LinkedIn's late SPA rendering. Bail fast on hard authwalls.
  const urls = [
    'https://www.linkedin.com/company/' + slug + '/about/',
    'https://www.linkedin.com/company/' + slug + '/'
  ];
  let best = { found: false, authwall: false };
  for (const url of urls) {
    const tabId = await ensureTab('li', url);
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForTabLoad(tabId, 28000);
      await sleep(1400);
      let out = null;
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractLinkedInCompany });
        out = frames && frames[0] && frames[0].result;
      } catch (e) { out = null; }
      if (!out) { await sleep(1800); continue; }
      last = out;
      if (out.authwall) break;                                    // wall → try next URL form
      if (out.found && (out.industry || out.size || out.hq || out.website)) return out;
      if (out.found && attempt >= 1) break;                       // name at least; accept
      await sleep(1800);                                          // late render — re-extract
    }
    if (last && last.found) best = last;
    if (best.found && (best.industry || best.size || best.hq || best.website)) return best;
    // name-only or walled → fall through and try the other URL form
  }
  return best;
}

// ------------------------------------------------------------ query plans ----

function stripQuotes(s) { return String(s || '').replace(/[""]/g, ' ').trim(); }

function buildQueries(item) {
  const name = stripQuotes(item.name || titleCaseSlug(item.slug));
  const q = [];
  // (v1.2: the resolve query moved to researchCompany step 1 — no duplicate here)
  const mode = SETTINGS.scanMode || 'standard';
  const execQ = 'site:linkedin.com/in "' + name + '" ("CEO" OR "CTO" OR "CIO" OR "COO" OR "Founder" OR "Co-Founder" OR "President" OR "Chief" OR "Owner" OR "Managing Director")';
  const leadQ = 'site:linkedin.com/in "' + name + '" ("Head of" OR "VP" OR "Vice President" OR "Director") ("Product" OR "Engineering" OR "Technology" OR "Software")';
  const aiQ = 'site:linkedin.com/in "' + name + '" ("AI" OR "Machine Learning" OR "Generative AI" OR "Automation" OR "Data Science")';
  const digQ = 'site:linkedin.com/in "' + name + '" ("Digital Transformation" OR "Innovation" OR "IT Director" OR "CISO" OR "Architect" OR "R&D")';
  if (mode === 'quick') q.push(execQ);
  else if (mode === 'standard') { q.push(execQ, leadQ); }
  else { q.push(execQ, leadQ, aiQ, digQ); }
  return q;
}

// ------------------------------------------------------ people assembly -----

function peopleFromSerp(serp, companyName, allowPartial, rejected = {}) {
  const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  const out = [];
  const seen = new Set();
  // Strict all-token match by default (anti-bleed). When a plain company name
  // could NOT be resolved to a LinkedIn page, the typed legal name won't appear
  // on profiles ("at Zoho" vs "Zoho Corporation") — fall back to partial
  // token matching, still scoped to this company's own search results.
  const match = allowPartial
    ? (hay) => companyMatch(hay, companyName) || companyMatchPartial(hay, companyName)
    : (hay) => companyMatch(hay, companyName);
  for (const r of serp) {
    const url = r.url || '';
    if (!isLinkedInProfile(url)) continue;
    const handle = linkedinHandle(url);
    if (!handle || seen.has(handle)) continue;
    const parsed = parseProfileTitle(r.title);
    if (!parsed || !parsed.name) { reject('unreadable title'); continue; }
    const titleHay = r.title || '';
    const snippetHay = r.snippet || '';
    // v1.4 precision: LinkedIn directory/collection handles are not people
    if (/^dir(\/|-|$)/i.test(handle) || /^(topic|groups?|pulse)\b/i.test(handle)) continue;
    const inTitle = match(titleHay, companyName);
    const inSnippet = match(snippetHay, companyName);
    if (!inTitle && !inSnippet) { reject('company mismatch'); continue; }
    // v1.3 role currency: keep only CURRENT roles at this company.
    // Title mentions are the indexed headline (current); snippet-only mentions
    // that carry past-role markers BEFORE the company name are dropped.
    const role = roleCurrency(inTitle, inSnippet, titleHay, snippetHay, companyName);
    if (role === 'past') { reject('past role'); continue; }
    seen.add(handle);
    const cls = classifyDesignation(parsed.designation);
    const confidence = role === 'current' ? 0.85 : (role === 'snippet' ? 0.55 : 0.45);
    out.push({
      name: parsed.name,
      designation: parsed.designation,
      url, handle,
      urlVerified: true,
      currentEmployer: role,
      source: 'bing',
      confidence: confidence,
      cat: cls.cat, pri: cls.pri, score: cls.sc
    });
  }
  return out;
}

function mergeAiPeople(base, aiPeople, serpHandles, companyName) {
  for (const p of (aiPeople || [])) {
    if (!p || !p.name) continue;
    // v1.3: the AI is instructed to emit current:true only for people who
    // hold that designation at this company NOW. Anything marked false (a
    // past role) is dropped outright.
    if (p.current === false) continue;
    const name = cell(p.name).slice(0, 120);
    if (!name) continue;
    let desig = cell(p.designation).slice(0, 120);
    let url = String(p.linkedin_url || '').trim();
    if (url && !isLinkedInProfile(url)) url = '';
    const handle = url ? linkedinHandle(url) : null;
    if (handle && !serpHandles.has(handle)) url = '';      // never keep an unverifiable URL
    const verified = !!(handle && serpHandles.has(handle) && url);

    const existing = base.find(b =>
      (handle && b.handle === handle) ||
      b.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!existing.designation && desig) existing.designation = desig;
      existing.confidence = Math.min(1, Math.max(existing.confidence, Number(p.confidence) || 0.5));
      continue;
    }
    const cls = classifyDesignation(desig || '');
    base.push({
      name, designation: desig, url, handle: handle || null,
      urlVerified: verified,
      currentEmployer: p.current === true ? 'current' : 'snippet',
      source: verified ? 'bing+ai' : 'ai',
      confidence: Math.min(1, (Number(p.confidence) || 0.5) * (verified ? 1 : 0.85)),
      cat: cls.cat, pri: cls.pri, score: Math.round(cls.sc * (verified ? 1 : 0.85))
    });
  }
  return base;
}

function finalizePeople(people, domain, includeEmails, hunterData) {
  for (const p of people) {
    const cls = classifyDesignation(p.designation || '');
    p.cat = cls.cat; p.pri = cls.pri;
    p.score = cls.sc + seniorityBonus(p.designation || '') + (p.urlVerified ? 6 : 0) +
      Math.round((p.confidence || 0.5) * 8);
    // currency demotion: possibly-past roles sink below verified-current ones
    if (p.currentEmployer === 'review-past') p.score -= 14;
    else if (p.currentEmployer === 'snippet') p.score -= 5;
    p.priority = 'P' + (p.pri || 5);
    if (includeEmails && domain) {
      let em = null;
      if (hunterData) {
        em = matchHunterEmail(p.name, hunterData.emails, hunterData.patternTemplate, domain);
      }
      if (!em) em = emailFor(p.name, domain);
      if (em) { p.email = em.email; p.emailStatus = em.status; }
    }
  }
  people.sort((a, b) => (a.pri || 9) - (b.pri || 9) || (b.score || 0) - (a.score || 0));
  return people.slice(0, 12);
}

// Common single-token countries seen as the whole HQ line ("Headquarters\nIndia")
const KNOWN_COUNTRIES = new Set(['india', 'usa', 'united states', 'united kingdom', 'uk',
  'canada', 'australia', 'germany', 'france', 'netherlands', 'spain', 'italy',
  'singapore', 'japan', 'china', 'south korea', 'brazil', 'mexico', 'uae',
  'united arab emirates', 'saudi arabia', 'israel', 'sweden', 'switzerland',
  'ireland', 'poland', 'new zealand', 'south africa', 'nigeria', 'kenya',
  'indonesia', 'malaysia', 'philippines', 'thailand', 'vietnam', 'pakistan',
  'bangladesh', 'sri lanka']);

function countryFromHq(hq) {
  if (!hq) return '';
  const parts = String(hq).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  // A bare city name is not a country — unless it IS a known country name
  if (parts.length === 1) {
    return KNOWN_COUNTRIES.has(last.toLowerCase()) ? last : '';
  }
  return last;
}

// Precision/recall helpers for company resolution (slugScore, overlapTokens,
// kebabName, looseResolveMatch) live in lib/parse.js — unit-tested there.

/**
 * Tier-1 resolver: load linkedin.com/company/<kebab-name>/about/ and verify.
 * The guessed URL is only ACCEPTED when the loaded page's real name shares at
 * least one token with the query — otherwise it is discarded (never fabricated).
 * On success this also captured the company facts in the same page load.
 */
async function guessCompanyByName(name) {
  const slug = kebabName(name);
  if (!slug) return null;
  const url = 'https://www.linkedin.com/company/' + slug + '/about/';
  const tabId = await ensureTab('li', url);
  await waitForTabLoad(tabId, 28000);
  await sleep(1400);
  let out = null;
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractLinkedInCompany });
    out = frames && frames[0] && frames[0].result;
  } catch (e) { out = null; }
  if (!out || !out.found || !out.name) return null;
  if (overlapTokens(out.name, name) === 0) return null; // a different company lives at that slug
  return { slug: slug, data: out };
}

// ------------------------------------------------------- main per-company ----

// Hunter.io lookup with a per-domain cache (quota-friendly: one request per
// domain across all runs). Returns {emails, patternTemplate} or null.
async function hunterLookup(domain, apiKey) {
  if (!domain || !apiKey) return null;
  const cacheKey = 'hunter:' + domain;
  try {
    const st = await chrome.storage.local.get([cacheKey]);
    if (st[cacheKey]) return st[cacheKey];
  } catch (e) { /* cache miss is fine */ }
  const data = await hunterDomainSearch(domain, apiKey);
  if (data) {
    try { await chrome.storage.local.set({ [cacheKey]: data }); } catch (e) { /* ignore */ }
  }
  return data;
}

async function researchCompany(item) {
  // v1.1: on retry, update the existing results entry instead of adding a
  // duplicate row (v1.0 bug: "Retry failed" created a second entry).
  let comp = null;
  const existingIdx = S.job.results.findIndex(c =>
    item.resultId ? c.id === item.resultId :
      c.id === item.id || (item.slug && c.slug === item.slug) || c.input === item.input);
  if (existingIdx !== -1) {
    comp = S.job.results[existingIdx];
    comp.status = 'working';
    comp.error = '';
    Object.assign(comp, { people: [], size: '', sizeSource: null, finishedAt: null });
    if (item.replaceCompany) Object.assign(comp, {
      input: item.input, type: item.type, name: item.name || titleCaseSlug(item.slug),
      slug: item.slug, url: item.slug ? 'https://www.linkedin.com/company/' + item.slug + '/' : '',
      industry: '', hq: '', website: '', country: '', factSource: 'none'
    });
  } else {
    comp = {
      id: item.id,
      input: item.input,
      type: item.type,
      slug: item.slug || null,
      url: item.slug ? ('https://www.linkedin.com/company/' + item.slug + '/') : '',
      name: item.name || titleCaseSlug(item.slug) || '',
      industry: '', size: '', hq: '', website: '', country: '',
      factSource: 'none',
      people: [], status: 'working', error: '', finishedAt: null
    };
    S.job.results.push(comp);
  }
  item.resultId = comp.id;
  const searchStats = () => ({ results: 0, profiles: 0, unreadable: 0, consent: 0, verification: 0, errors: 0 });
  const d = comp.diagnostics = {
    resolution: item.type === 'url' ? 'provided URL' : (comp.slug ? 'previous match' : 'unresolved'),
    resolutionSearch: searchStats(), peopleSearch: searchStats(), rejected: {}, ai: 'not reached'
  };
  const search = async (query, stats = d.peopleSearch) => {
    try { return await bingSearch(query, stats); }
    catch (error) {
      if (!S.job.paused) stats.errors++;
      throw error;
    }
  };
  await persist();

  const companyName = () => comp.name || item.name || titleCaseSlug(item.slug) || '';

  // ---- 1. resolve slug for plain names (3-tier, recall-first) ---------------
  let preScan = null;
  if (item.type === 'name') {
    if (SETTINGS.deepScan) {
      // Tier 1 — direct slug guess + on-page verification (also captures facts)
      preScan = await guessCompanyByName(comp.name);
      if (preScan) {
        d.resolution = 'LinkedIn page match';
        comp.slug = preScan.slug;
        comp.url = 'https://www.linkedin.com/company/' + comp.slug + '/';
      }
    }
    if (!comp.slug) {
      // Tier 2 — Bing resolve with recall-friendly matching + scoring
      const candidates = [];
      const collect = (list) => {
        for (const r of list) {
          const slug = slugFromUrl(r.url);
          if (!slug) continue;
          if (slug.toLowerCase() === 'company' || slug.toLowerCase().startsWith('page')) continue;
          const loose = looseResolveMatch(r.title || '', r.snippet || '', slug, comp.name);
          if (loose <= 0) continue;
          candidates.push({ slug: slug, score: loose * 10 + slugScore(slug, comp.name) });
        }
      };
      collect(await search('"' + stripQuotes(comp.name) + '" site:linkedin.com/company', d.resolutionSearch));
      if (!candidates.length) {
        collect(await search(stripQuotes(comp.name) + ' site:linkedin.com/company', d.resolutionSearch));
      }
      if (!candidates.length) {
        collect(await search(comp.name + ' linkedin company page', d.resolutionSearch));
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score); // stable — ties keep SERP order
        d.resolution = 'Bing company match';
        comp.slug = candidates[0].slug;
        comp.url = 'https://www.linkedin.com/company/' + candidates[0].slug + '/';
      }
    }
  }

  // ---- 2. deep scan the LinkedIn company page ------------------------------
  let liData = null;
  if (SETTINGS.deepScan && comp.slug) {
    if (preScan && preScan.slug === comp.slug && preScan.data && preScan.data.found) {
      liData = preScan.data; // facts were already captured while resolving
    } else {
      liData = await readLinkedInCompany(comp.slug);
    }
    if (liData && !liData.authwall && liData.found) {
      if (liData.name && liData.name.length > 1) comp.name = liData.name;
      if (liData.industry) comp.industry = liData.industry;
      if (liData.size && slugFromUrl(liData.pageUrl)?.toLowerCase() === comp.slug.toLowerCase()) {
        comp.size = liData.size;
        comp.sizeSource = comp.url;
      }
      if (liData.hq) comp.hq = liData.hq;
      if (liData.website) comp.website = liData.website;
      comp.factSource = 'linkedin';
    } else if (liData && liData.authwall) {
      comp.factSource = 'none'; // fall back to AI/SERP facts
    }
  }

  // ---- 3. scoped Bing queries for decision-makers --------------------------
  let serp = [];
  const allowPartial = (item.type === 'name' && !comp.slug);
  const queries = buildQueries({ type: item.type, name: companyName(), slug: item.slug });
  for (const q of queries) {
    const res = await search(q);
    serp = serp.concat(res);
    if (S.job.paused) throw new Error('paused');
  }

  // low yield → one extra broad query (skip in deep mode which already has it)
  const profileCount = serp.filter(r => isLinkedInProfile(r.url)).length;
  if (profileCount < 2 && (SETTINGS.scanMode || 'standard') !== 'deep') {
    const extra = await search('site:linkedin.com/in "' + stripQuotes(companyName()) +
      '" ("AI" OR "Machine Learning" OR "Digital" OR "Innovation" OR "Engineering")');
    serp = serp.concat(extra);
  }

  d.peopleSearch.profiles = new Set(serp.filter(r => isLinkedInProfile(r.url))
    .map(r => linkedinHandle(r.url)).filter(Boolean)).size;
  const bingPeople = peopleFromSerp(serp, companyName(), allowPartial, d.rejected);

  // ---- 4. AI enrichment ----------------------------------------------------
  let aiNote = '';
  const prov = SETTINGS.provider || 'none';
  const hasKey = !!(SETTINGS.keys && (SETTINGS.keys[prov] || (prov === 'custom' && SETTINGS.customBase)));
  // Grounded research helps twice: when people are scarce AND when the
  // LinkedIn page was walled and company facts are still missing (RC7).
  const groundedCandidate = prov === 'gemini' && hasKey &&
    (serp.filter(r => isLinkedInProfile(r.url)).length < 2 || comp.factSource === 'none');
  d.ai = SETTINGS.aiAssist === false || prov === 'none' ? 'disabled' : prov + ' key missing';
  if (SETTINGS.aiAssist !== false && prov !== 'none' && hasKey) {
    try {
      const out = await aiResearch({
        provider: prov, settings: SETTINGS,
        companyName: companyName(),
        companyUrl: comp.url,
        serp,
        grounded: groundedCandidate
      });
      // grounded citations are real URLs — add them to the corpus before merging
      const extraSerp = (out.cites || []).map(c => ({ title: c.title, url: c.url, snippet: 'AI grounding citation' }));
      serp = serp.concat(extraSerp);
      const serpHandles = new Set(serp.map(r => linkedinHandle(r.url)).filter(Boolean));
      comp.people = mergeAiPeople(peopleFromSerp(serp, companyName(), allowPartial), out.people, serpHandles, companyName());
      // facts: never overwrite LinkedIn-verified facts; fill gaps only
      const c = out.company || {};
      if (!comp.industry && c.industry) comp.industry = cell(c.industry);
      if (!comp.hq && c.hq) comp.hq = cell(c.hq);
      if (!comp.website && c.website) comp.website = cell(c.website);
      if (!comp.country && c.country) comp.country = cell(c.country);
      if (comp.factSource === 'none' && (comp.industry || comp.size || comp.hq)) comp.factSource = 'ai';
      aiNote = out.note || 'ai';
      d.ai = prov + ' returned ' + out.people.length + ' candidate(s)';
    } catch (e) {
      aiNote = 'ai-failed';
      const http = /\bAI HTTP (\d{3})\b/.exec(String(e.message));
      d.ai = prov + ' failed' + (http ? ' (HTTP ' + http[1] + ')' : '') + '; used Bing results';
      comp.people = bingPeople;
    }
  } else {
    comp.people = bingPeople;
  }

  // ---- 5. finalize ---------------------------------------------------------
  if (!comp.website) comp.website = '';
  const domain = domainFromWebsite(comp.website);
  if (!comp.country && comp.hq) comp.country = countryFromHq(comp.hq);
  // v1.3 emails: optional Hunter.io (free key) gives real addresses / verified
  // domain patterns; without it, pattern estimates are used and flagged.
  let hunterData = null;
  if (SETTINGS.includeEmails !== false && domain &&
      SETTINGS.keys && SETTINGS.keys.hunter) {
    hunterData = await hunterLookup(domain, SETTINGS.keys.hunter);
  }
  comp.people = finalizePeople(comp.people, domain, SETTINGS.includeEmails !== false, hunterData);
  comp.aiNote = aiNote;
  comp.status = 'done';
  comp.finishedAt = Date.now();
  S.job.doneCount += 1;
  S.job.perCompanyMs = S.job.startedAt ?
    Math.round((Date.now() - S.job.startedAt) / Math.max(1, S.job.doneCount)) : 0;
  await persist();
}

// ------------------------------------------------------------- the pump ----

async function pump() {
  if (S.busy || !S.job.running || S.job.paused) return;
  const myRun = S.runId; // a newer Start invalidates this loop generation
  S.busy = true;
  try {
    while (S.job.running && !S.job.paused && S.runId === myRun &&
           S.job.cursor < S.job.queue.length) {
      const item = S.job.queue[S.job.cursor];
      if (!item) { S.job.cursor++; continue; }
      if (item.status === 'queued') {
        item.status = 'working';
        item.startedAt = Date.now();
        await persist();
        try {
          await researchCompany(item);
          if (S.runId !== myRun) break; // superseded mid-research — leave state to the new run
          item.status = 'done';
        } catch (e) {
          if (S.runId !== myRun) break;
          if (!S.job.running) break;
          const company = S.job.results.find(c => c.id === item.resultId);
          if (S.job.paused) {
            item.status = 'queued';
            if (company) company.status = 'paused';
            await persist();
            break;
          }
          item.status = 'failed';
          if (company) company.status = 'failed';
          item.error = String(e.message || e).slice(0, 200);
        }
        S.job.cursor++;
        await persist();
        setBadge();
        await sleep(jitter(600));
      } else {
        S.job.cursor++; // skip already-done/failed items on resume
      }
    }
    if (S.runId === myRun && S.job.running && S.job.cursor >= S.job.queue.length) {
      S.job.running = false;
      S.job.finishedAt = Date.now();
      const done = S.job.queue.filter(q => q.status === 'done').length;
      notify('ls-done', 'LeadScout finished',
        done + ' of ' + S.job.queue.length + ' companies researched. Open LeadScout to export TSV.');
      stopHeartbeat();
      await closeWorkerTabs();
      await persist();
      setBadge();
    }
  } finally {
    S.busy = false;
    // a newer Start was requested while this loop was finishing — kick it now
    if (S.job.running && !S.job.paused && S.runId !== myRun) pump();
  }
}

function startHeartbeat() {
  stopHeartbeat();
  S.heartbeat = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
  }, 20000);
}
function stopHeartbeat() {
  if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
}

// v1.4: close the hidden worker tabs when the queue stops — frees memory
async function closeWorkerTabs() {
  for (const key of ['tabBing', 'tabLI']) {
    const id = S[key];
    if (id) {
      try { await chrome.tabs.remove(id); } catch (e) { /* already closed */ }
      S[key] = null;
    }
  }
}

// ---------------------------------------------------------- message router ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'start' || msg.type === 'retryCompany') {
        await loadAll();
        let inputs = msg.items || [];
        if (msg.type === 'retryCompany') {
          if (S.busy || S.job.running || S.job.paused) throw new Error('Finish or stop the current batch before retrying.');
          const c = S.job.results.find(result => result.id === msg.id);
          if (!c) throw new Error('Company result no longer exists.');
          let slug = c.slug;
          if (msg.url) {
            const replacement = new URL(msg.url);
            slug = replacement.protocol === 'https:' &&
              /^(?:[a-z]{2,4}\.)?linkedin\.com$/i.test(replacement.hostname) &&
              !replacement.username && !replacement.password && !replacement.port &&
              /^\/company\/[a-z0-9_.%-]+(?:\/(?:about|people|jobs))?\/?$/i.test(replacement.pathname)
              ? slugFromUrl(replacement.href) : null;
          }
          if (msg.url && !slug) throw new Error('Enter a direct LinkedIn company URL.');
          inputs = [{ resultId: c.id, replaceCompany: !!msg.url, type: slug ? 'url' : 'name', slug,
            name: msg.url ? null : c.name, input: msg.url || c.input }];
        }
        const items = inputs.map((it, i) => ({
          id: 'c' + Date.now() + '_' + i,
          type: it.type, slug: it.slug || null, name: it.name || null,
          input: it.input, resultId: it.resultId, replaceCompany: it.replaceCompany, status: 'queued', error: ''
        }));
        // merge with any leftover queued items, keep existing results
        const leftovers = S.job.queue.filter(q => q.status === 'queued');
        S.job.queue = msg.type === 'retryCompany' ? items.concat(leftovers) : leftovers.concat(items);
        S.job.cursor = 0;
        S.runId++; // invalidate any in-flight run generation
        S.job.running = true;
        S.job.paused = false;
        S.job.attention = null;
        S.job.startedAt = Date.now();
        S.job.finishedAt = null;
        S.job.doneCount = 0;
        S.job.perCompanyMs = 0;
        await persist();
        setBadge();
        startHeartbeat();
        pump();
        sendResponse({ ok: true, count: S.job.queue.length });
      } else if (msg.type === 'pause') {
        S.job.paused = true;
        await persist();
        sendResponse({ ok: true });
      } else if (msg.type === 'resume') {
        if (!S.job.running) throw new Error('No paused batch to resume.');
        S.job.paused = false;
        S.job.attention = null;
        // companies that were mid-flight (or aborted) when paused go back to queued
        const cur = S.job.queue[S.job.cursor];
        if (!S.busy && cur?.status === 'working') cur.status = 'queued';
        for (const [index, q] of S.job.queue.entries()) {
          if (q.status === 'failed' && /paused/i.test(q.error || '')) {
            q.status = 'queued';
            q.error = '';
            S.job.cursor = Math.min(S.job.cursor, index);
          }
        }
        await persist();
        startHeartbeat();
        pump();
        sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        S.job.running = false;
        S.job.paused = false;
        S.job.finishedAt = Date.now();
        stopHeartbeat();
        await closeWorkerTabs();
        await persist();
        setBadge();
        sendResponse({ ok: true });
      } else if (msg.type === 'clearResults') {
        S.job.queue = [];
        S.job.results = [];
        S.job.cursor = 0;
        S.job.running = false;
        S.job.paused = false;
        S.job.attention = null;
        await persist();
        setBadge();
        sendResponse({ ok: true });
      } else if (msg.type === 'getSettings') {
        await loadAll();
        sendResponse({ ok: true, settings: SETTINGS });
      } else if (msg.type === 'setSettings') {
        SETTINGS = { ...DEFAULT_SETTINGS, ...msg.settings, keys: { ...DEFAULT_SETTINGS.keys, ...(msg.settings.keys || {}) } };
        await saveSettings();
        sendResponse({ ok: true });
      } else if (msg.type === 'addCurrentPage') {
        const tabId = S.lastActiveTab;
        if (!tabId) {
          sendResponse({ ok: false, error: 'No active tab seen yet — visit a LinkedIn company page, then click again.' });
        } else {
          let tab = null;
          try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; }
          const url = tab && tab.url ? tab.url : '';
          if (!tab || !/linkedin\.com\/company\//i.test(url)) {
            sendResponse({ ok: false, error: 'Open a LinkedIn company page first' });
          } else {
            let line = url;
            try {
              const frames = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: extractLinkedInCompany
              });
              const r = frames && frames[0] && frames[0].result;
              if (r && r.name) line = r.name + ' - ' + url;
            } catch (e) {
              // fall back to URL-only line; the pipeline title-cases the slug
            }
            sendResponse({ ok: true, line: line });
          }
        }
      } else if (msg.type === 'testAI') {
        const out = await aiTestKey(msg.provider, msg.settings || SETTINGS);
        sendResponse({ ok: true, message: out });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async sendResponse
});

// ------------------------------------------------------------- lifecycle ----

// Track the last active tab so the popup's "Add current page" works without
// needing the tabs-query API (and without asking for extra permissions).
chrome.tabs.onActivated.addListener((info) => {
  try { S.lastActiveTab = info.tabId; } catch (e) { /* ignore */ }
});

chrome.alarms.create('ls-pump', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ls-pump' && S.job.running && !S.job.paused) pump();
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadAll();
  await saveSettings();
});

// Service-worker restart recovery: resume an interrupted job automatically.
(async () => {
  await loadAll();
  if (S.job.running) {
    // anything stuck in 'working' when the worker died goes back to queued
    for (const q of S.job.queue) if (q.status === 'working') q.status = 'queued';
    await persist();
    setBadge();
    startHeartbeat();
    pump();
  }
})();
