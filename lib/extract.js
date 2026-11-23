// LeadScout — DOM extractors injected into live pages (v1.1).
// These run inside bing.com / linkedin.com pages, so they must be FULLY
// self-contained: no module-scope references, no closures over imports.
// (v1.0 bug: an injected function referenced a module helper → ReferenceError
// inside the page → every failing extraction silently returned empty.)

export function extractBingResults() {
  const out = { results: [], captcha: false, consent: false, noResults: false, title: document.title || '' };
  const t = String(document.title || '');
  if (/verify|unusual traffic|are you human|challenge/i.test(t)) out.captcha = true;
  const bodyTxt = String(document.body.innerText || '').slice(0, 20000);
  if (/unusual traffic|not a robot|verify you|confirm you are human/i.test(bodyTxt)) out.captcha = true;
  // First-run / region-consent interstitial: no result list at all
  if (!document.querySelector('#b_results') && !document.querySelector('form[action*="/search"]')) {
    out.consent = true;
  }

  const seen = {};
  const push = (title, url, snippet) => {
    if (!url) return;
    if (seen[url]) return;
    seen[url] = { title: String(title || '').trim(), url: String(url), snippet: String(snippet || '').trim() };
    out.results.push(seen[url]);
  };

  // Strategy 1 — standard Bing organic blocks (b_algo), multiple selectors
  const lis = document.querySelectorAll('#b_results li.b_algo');
  for (const li of lis) {
    const a = li.querySelector('h2 a') || li.querySelector('a[href]');
    if (!a || !a.href) continue;
    let snip = '';
    const snipEl = li.querySelector('.b_caption p') || li.querySelector('.b_caption') ||
      li.querySelector('.b_algoSlug') || li.querySelector('p');
    if (snipEl) snip = String(snipEl.innerText || '').trim();
    push(a.innerText, a.href, snip);
  }

  // Strategy 2 — fallback sweep: ANY anchor that points at a LinkedIn profile.
  // Guarantees person discovery even if Bing changes its markup classes.
  if (out.results.length < 3) {
    const anchors = document.querySelectorAll('a[href*="linkedin.com/in/"], a[href*="/in/"]');
    for (const a of anchors) {
      const href = String(a.href || '');
      if (!/linkedin\.com\/in\//i.test(href)) continue;
      if (/linkedin\.com\/in\/(dir|topic|groups)/i.test(href)) continue;
      const card = a.closest('li, .b_algo, .b_ans') || a.parentElement;
      const snip = card ? String(card.innerText || '').slice(0, 400) : '';
      push(a.innerText, href, snip);
    }
  }

  if (!out.results.length && !out.captcha) {
    const html = String(document.body.innerHTML || '');
    out.noResults = /There are no results for/i.test(html) || /b_no/.test(html);
  }
  return out;
}

export function extractLinkedInCompany() {
  const out = { found: false, authwall: false, name: '', industry: '', size: '', hq: '', website: '', pageUrl: location.href };
  const title = String(document.title || '');
  const txt = String(document.body.innerText || '');

  // ---- 1. Company name: h1 → og:title → JSON-LD Organization → page title ----
  let name = '';
  try {
    const h1 = document.querySelector('main h1') || document.querySelector('h1');
    if (h1 && h1.innerText) {
      const firstLine = String(h1.innerText).split('\n')[0].trim();
      if (firstLine && !/^sign|^log ?in/i.test(firstLine)) name = firstLine;
    }
  } catch (e) { /* ignore */ }
  let ldName = '';
  try {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let j = null;
      try { j = JSON.parse(String(s.textContent || '')); } catch (e2) { j = null; }
      if (!j) continue;
      const nodes = Array.isArray(j) ? j : (j['@graph'] ? j['@graph'] : [j]);
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
        if (types && types.indexOf('Organization') !== -1 && n.name) ldName = String(n.name);
      }
    }
  } catch (e) { /* ignore */ }
  if (!name && ldName) name = ldName;
  if (!name) {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) name = String(og.content).split('|')[0].trim();
  }
  if (!name) name = String(title.split('|')[0] || '').replace(/[:\s]*Jobs.*$/i, '').trim();

  // ---- 2. Labeled fields from rendered text (About panel / guest <dl>) ----
  const grab = (label) => {
    const lines = txt.split('\n');
    const lab = label.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '').trim();
      if (line.toLowerCase() === lab || line.toLowerCase().startsWith(lab + ':')) {
        let v = line.slice(label.length).replace(/^[\s:]+/, '').trim();
        if (!v && i + 1 < lines.length) v = String(lines[i + 1] || '').trim();
        if (v) return v.slice(0, 180);
      }
    }
    return '';
  };
  out.industry = grab('Industry');
  const size = grab('Company size');
  out.size = /^\d[\d,]*(?:\+|\s*(?:[-–—]|to)\s*\d[\d,]*)?\s+employees$/i.test(size) ? size : '';
  out.hq = grab('Headquarters');
  out.website = grab('Website');

  // ---- 3. Fallbacks: og:description + page text + website anchors ----
  let ogDesc = '';
  try {
    const m = document.querySelector('meta[property="og:description"]');
    if (m && m.content) ogDesc = String(m.content);
  } catch (e) { /* ignore */ }
  const hay = ogDesc + ' ' + txt.slice(0, 12000);

  if (!out.website) {
    const w = (ogDesc + ' ' + txt.slice(0, 8000)).match(/website\s*[:\|\u2022]\s*((?:https?:\/\/|www\.)[^\s,;]{3,120})/i);
    if (w) out.website = w[1];
  }
  if (!out.website) {
    // The About-panel website link renders as a bare domain ("acme.com")
    const anchors = document.querySelectorAll('a[href^="http"]');
    for (const a of anchors) {
      const href = String(a.href || '');
      if (/linkedin\.com|microsoft\.com|licdn\.com/i.test(href)) continue;
      const text = String(a.innerText || '').trim().replace(/\/$/, '');
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(text)) {
        out.website = href.split('?')[0];
        break;
      }
    }
  }
  if (!out.hq) {
    // og:description on company pages often ends with "City, Region, Country"
    const m = hay.match(/\b\d{1,3}[\d,]*\s+followers?[^.\n]{0,200}?[.|]\s*([A-Z][A-Za-z .,'-]+,\s*[A-Z][A-Za-z .,'-]+(?:,\s*[A-Z][A-Za-z .,'-]+)?)/);
    if (m) out.hq = m[1].trim();
  }

  out.authwall =
    (/authwall|log ?in|sign ?in|join linkedin/i.test(title) && !ldName && !out.industry && !out.size) ||
    (/^sign (in|up)/i.test(txt.slice(0, 160)) && !out.industry && !out.size && !out.hq && !ldName);
  out.found = !!name && !out.authwall;
  out.name = name.replace(/\s*:\s*(?:about|home|jobs|people)\s*$/i, '').trim();
  return out;
}
