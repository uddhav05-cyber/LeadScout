// LeadScout — pure logic shared by background, popup and results page.
// No chrome.* APIs in this module so it can be unit-tested with plain Node.

export const DEFAULT_SETTINGS = {
  provider: 'groq',            // groq | gemini | openrouter | custom | none
  keys: { groq: '', gemini: '', openrouter: '', custom: '', hunter: '' },
  // v1.4: model ids rotate as providers deprecate them — these overrides let
  // the user pin a current model without touching code ("latest always")
  models: { groq: '', gemini: '', openrouter: '', custom: '' },
  customBase: '',
  customModel: '',
  scanMode: 'standard',        // quick | standard | deep
  deepScan: true,              // open LinkedIn company page to read verified facts
  includeEmails: true,         // pattern-estimated emails, always flagged as unverified
  aiAssist: true,              // structure + enrich using the chosen provider
  bingDelayMs: 2200,           // base delay between Bing queries (±jitter)
  searchHost: 'www.bing.com',
  theme: 'dark'
};

export const PROVIDERS = {
  groq: {
    label: 'Groq (free tier — console.groq.com)',
    base: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    kind: 'openai'
  },
  gemini: {
    label: 'Google Gemini (free tier — aistudio.google.com, web-grounded)',
    base: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    model: 'gemini-3.8-flash',
    kind: 'gemini'
  },
  openrouter: {
    label: 'OpenRouter (free models — openrouter.ai)',
    base: 'https://openrouter.ai/api/v1/chat/completions',
    items: null,
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    kind: 'openai'
  },
  custom: { label: 'Custom OpenAI-compatible endpoint', kind: 'openai' },
  none: { label: 'No AI — Bing extraction only', kind: null }
};

// ---------------------------------------------------------------- input ----

const LI_COMPANY_RE = /https?:\/\/(?:[a-z]{2,4}\.)?linkedin\.com\/company\/([A-Za-z0-9_%\-\.]+)/i;

export function slugFromUrl(u) {
  const m = String(u || '').match(LI_COMPANY_RE);
  if (!m) return null;
  let slug = m[1].replace(/\.html?$/i, '');
  if (!slug) return null;
  return slug;
}

export function titleCaseSlug(slug) {
  const spaced = (slug || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/%20/g, ' ')
    .trim();
  return spaced.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1));
}

export function normalizeName(name) {
  return (name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Split raw textarea input into a deduped queue.
 * A line may be: a LinkedIn company URL, "Name - URL", or just a company name.
 */
export function parseInputs(raw) {
  const seen = new Set();
  const items = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim().replace(/^[\-\*\d\.\)\s]+/, '').replace(/[",]+$/, '').trim();
    if (!line) continue;
    const urlMatch = String(line).match(LI_COMPANY_RE);
    if (urlMatch) {
      const slug = slugFromUrl(urlMatch[0]);
      if (slug && !seen.has('u:' + slug.toLowerCase())) {
        seen.add('u:' + slug.toLowerCase());
        // Support "Company Name - https://..." / "Company Name | https://..." lines
        let displayName = null;
        const beforeUrl = line.slice(0, urlMatch.index).trim();
        if (beforeUrl) {
          displayName = normalizeName(beforeUrl.replace(/[-–—|:\s]+$/, '').trim());
        }
        items.push({ type: 'url', slug, name: displayName || null, input: urlMatch[0] });
      }
      continue;
    }
    // Strip a trailing URL if someone pasted "Name https://..." on one line
    let name = normalizeName(line.replace(LI_COMPANY_RE, '').replace(/\s{2,}/g, ' '));
    if (!name) continue;
    const key = 'n:' + name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); items.push({ type: 'name', slug: null, name, input: name }); }
  }
  return items;
}

// ------------------------------------------------------- Bing SERP utils ----

/**
 * Bing wraps organic links in /ck/a redirect URLs like:
 *   https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9saW5rZWRpbi5jb20vaW4v...
 * Decode the `u` parameter (strip leading "a1", base64url decode).
 */
export function decodeBingUrl(href) {
  if (!href) return '';
  try {
    if (/bing\.com\/ck\/a/i.test(href)) {
      const m = String(href).match(/[?&]u=a1([A-Za-z0-9\-_]+)/);
      if (m) {
        let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const dec = atob(b64);
        if (/^https?:\/\//i.test(dec)) return dec;
      }
    }
  } catch (e) { /* fall through */ }
  return href;
}

const JUNK_TITLE_RE = /(on linkedin[:\s]|#?\d[\d,]*\s+followers?|[\d,]+\s+connections?|linkedin: (log in|sign up)|explore|jobs on linkedin)/i;

// Title keywords that identify the DESIGNATION segment (v1.1: a segment
// without any keyword is treated as company/affiliation — NOT as designation).
const DESIG_KW_RE = /(ceo|cto|cio|cdo|coo|cfo|ciso|cpo|chief|founder|co-?founder|president|owner|managing director|vp|vice president|director|head of|general manager|partner|principal|country manager|zonal|regional|innovation|transformation|architect|engineering|developer|scientist|research|technology|product|data)/i;

// Strict leading-title pattern for single-segment titles: "Jane Doe CEO at Acme"
const LEADING_TITLE_RE = /^(.+?)\s+((?:co-?founder|founder|ceo|cto|cio|cdo|coo|cfo|ciso|cpo|president|owner|chief|managing director|vp|vice president|director|head of|general manager)\b.*)$/i;

/**
 * Parse a Bing result title like:
 *   "Jane Doe - Chief Technology Officer - Acme Corp | LinkedIn"
 *   "John Smith - Founder & CEO at Acme | LinkedIn"
 *   "Jane Doe CEO at Acme | LinkedIn"  (single segment)
 * into { name, designation } — designation may be '' when the SERP title
 * shows only an affiliation. Returns null for junk rows.
 */
export function parseProfileTitle(rawTitle) {
  if (!rawTitle) return null;
  let t = rawTitle.replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
  t = t.replace(/\s*[-–—|]\s*(LinkedIn\s*(India|UK|US)?)\s*$/i, '').trim();
  if (JUNK_TITLE_RE.test(t)) return null;
  // Split on common separators, keep 2-4 segments
  let parts = t.split(/\s+[-–—]\s+|\s*\|\s*|\s+[•·]\s+/).map(s => s.trim()).filter(Boolean);
  // Single-segment fallback: "Jane Doe CEO at Acme"
  if (parts.length === 1 && LEADING_TITLE_RE.test(parts[0])) {
    const m = parts[0].match(LEADING_TITLE_RE);
    if (m) parts = [m[1], m[2]];
  }
  if (parts.length < 2) return null;
  // Name = first short, name-like segment
  const nameCandidate = parts[0].replace(/\(.*?\)/g, '').replace(/[\d,]+.*$/, '').trim();
  if (!nameCandidate || nameCandidate.length < 3 || nameCandidate.split(/\s+/).length > 6) return null;
  if (!/[A-Za-z]/.test(nameCandidate)) return null;
  // Designation = the segment with a title keyword (longest such segment).
  // v1.0 bug: fell back to parts[1] — putting the COMPANY NAME into the
  // designation column. Now a keyword-less segment yields designation ''.
  let designation = '';
  for (let i = 1; i < parts.length; i++) {
    if (DESIG_KW_RE.test(parts[i])) {
      if (parts[i].length > designation.length) designation = parts[i];
    }
  }
  designation = designation
    .replace(/\s+at\s+.*$/i, '')           // strip " at Company"
    .replace(/\s*@\s*.*$/, '')             // strip " @Company"
    .replace(/\s*\|.*$/, '')
    .replace(/^[,\-–—\s]+|[,\-–—\s]+$/g, '')
    .trim();
  return { name: nameCandidate, designation: designation.slice(0, 120) };
}

/**
 * Pull a company-size phrase out of SERP titles/snippets:
 *   "5,001-10,000 employees" / "201 to 500 employees" / "over 200 employees"
 * Returns null when absent. (RC5: LinkedIn pages are frequently authwalled —
 * Bing snippets of company pages carry the size, so we recover it there.)
 */
export function extractSizeFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/(\d[\d,]{0,9})\s*(?:[-\u2013\u2014]|to)\s*(\d[\d,]{0,9})\s*employees/i);
  if (m) return m[1] + '-' + m[2] + ' employees';
  m = s.match(/\b(\d[\d,]{0,9})\s*employees\b/i);
  if (m) return m[1] + ' employees';
  return null;
}

export function linkedinHandle(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^\/\?&#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function isLinkedInProfile(url) {
  return /linkedin\.com\/in\//i.test(url || '');
}

/**
 * Does `text` plausibly refer to `companyName`?
 * Token-based: every significant token of the company name appears in the text
 * (ignore case, common legal/geo filler words). Single-word companies must match fully.
 */
const FILLER = new Set(['inc', 'llc', 'ltd', 'limited', 'gmbh', 'pte', 'co', 'corp', 'corporation',
  'company', 'group', 'holdings', 'the', 'and', 'of', 'india', 'usa', 'us', 'uk', 'bv', 'ag', 'sa',
  // common legal/brand suffixes (esp. Indian corporate names) that LinkedIn
  // titles usually drop: "Nuclearis Technologies" → page "Nuclearis"
  'pvt', 'private', 'technologies', 'technology', 'solutions', 'systems', 'labs',
  'ventures', 'enterprises', 'industries', 'consulting', 'telecom', 'software',
  'international', 'global', 'worldwide', 'trading', 'associates', 'projects']);

export function companyMatch(text, companyName) {
  if (!text || !companyName) return false;
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const tokens = companyName.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/)
    .map(t => t.replace(/&/g, '')).filter(t => t.length >= 2 && !FILLER.has(t));
  if (!tokens.length) return false;
  return tokens.every(t => hay.includes(' ' + t + ' '));
}

/**
 * Recall-friendly variant used ONLY as a fallback: when a plain company name
 * could not be resolved to a LinkedIn page, the typed legal name ("Zoho
 * Corporation") won't appear on profiles that just say "at Zoho" — strict
 * all-token matching rejects everyone. Partial match needs ONE significant
 * token (≥3 chars) and is applied only to company-scoped search results.
 */
export function companyMatchPartial(text, companyName) {
  if (!text || !companyName) return false;
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const tokens = companyName.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/)
    .map(t => t.replace(/&/g, '')).filter(t => t.length >= 3 && !FILLER.has(t));
  if (!tokens.length) return false;
  return tokens.some(t => hay.includes(' ' + t + ' '));
}

// ------------------------------------------------- name-mode resolution ----

/** How many tokens of textA appear in textB as whole words (≥2 chars). */
export function overlapTokens(textA, textB) {
  const ta = String(textA || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  const tb = ' ' + String(textB || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ') + ' ';
  let n = 0;
  for (const t of ta) {
    if (tb.indexOf(' ' + t + ' ') !== -1) n++;
  }
  return n;
}

/** "Tata Consultancy Services" → "tata-consultancy-services" (LinkedIn slug shape). */
export function kebabName(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Precision helper: token overlap between a LinkedIn slug and the typed name. */
export function slugScore(slug, name) {
  const sTokens = String(slug || '').toLowerCase().split(/[-_]+/).filter(t => t.length >= 2);
  const nTokens = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  let score = 0;
  for (const st of sTokens) {
    if (nTokens.indexOf(st) !== -1) score += 3;
  }
  return score;
}

/**
 * Tier-2 resolver gate: recall-friendly matching for Bing company-page results.
 * Returns a confidence tier (2 strong / 1 weak / 0 reject). The strict
 * all-token gate rejected correct pages whose LinkedIn title is shorter than
 * the typed legal name ("Zoho" for "Zoho Corporation").
 */
export function looseResolveMatch(title, snippet, slug, name) {
  const low = (String(title || '') + ' ' + String(snippet || '')).toLowerCase();
  const nTokens = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  if (!nTokens.length) return 0;
  // strong: the full typed name appears in the result text
  if (low.indexOf(String(name).toLowerCase()) !== -1) return 2;
  // strong: every significant token present in title/snippet
  if (nTokens.every(t => low.indexOf(t) !== -1)) return 2;
  // medium: the slug alone covers every significant query token
  const sTokens = String(slug || '').toLowerCase().split(/[-_]+/).filter(t => t.length >= 2);
  const slugJoined = ' ' + sTokens.join(' ') + ' ';
  if (nTokens.every(t => slugJoined.indexOf(' ' + t + ' ') !== -1)) return 2;
  // weak: token overlap on both slug and text (scoring picks the best candidate)
  const slugHit = nTokens.some(t => slugJoined.indexOf(' ' + t + ' ') !== -1);
  const textHit = nTokens.some(t => low.indexOf(t) !== -1);
  if (slugHit && textHit) return 1;
  return 0;
}

// ---------------------------------------------------- role currency (v1.3) ----
// The user wants the CURRENT designation at THIS company — not a past one.
// Bing titles carry the profile's indexed headline (usually the current role);
// snippets can mention old roles. So:
//   company in TITLE           → current role, title-verified
//   company only in SNIPPET    → weaker; if the snippet also carries a
//                                past-role marker ("former", "ex-", "previously",
//                                "was CEO") the person is DROPPED
//   company in BOTH + marker   → contradictory evidence → flagged for review
// Exported for unit tests; used by background.peopleFromSerp.

export const ROLE_PAST_RE = /\b(?:former|past|previously)\b|\bex\s?[-\s]?\s?(?:ceo|cto|cio|coo|cfo|ciso|cpo|chief|founder|co-?founder|director|head|vp|vice|president|owner|partner|manager|employee)\b|\bwas\s+(?:a|an|the)?\s*(?:ceo|cto|cio|coo|cfo|ciso|cpo|chief|founder|co-?founder|director|head|vp|vice president|president|owner|partner|manager)\b/i;

// Index of the first significant company token inside a NORMALIZED snippet.
function firstCompanyTokenIndex(normSnippet, companyName) {
  const tokens = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s&]/g, ' ')
    .split(/\s+/).map(t => t.replace(/&/g, '')).filter(t => t.length >= 3 && !FILLER.has(t));
  let best = -1;
  for (const t of tokens) {
    const idx = normSnippet.indexOf(' ' + t + ' ');
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/**
 * Snippet-only currency: a past-role marker is only fatal when it appears
 * BEFORE the company mention ("Former CEO at Acme", "was CTO of Acme").
 * "Acme Corp engineer, previously at Google" names the company first — the
 * marker refers to an older job elsewhere → the role is current here.
 */
function snippetCurrency(snippetHay, companyName) {
  // padded — company tokens are matched with leading/trailing spaces
  const norm = ' ' + String(snippetHay || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (!ROLE_PAST_RE.test(norm)) return 'snippet';
  const m = norm.match(ROLE_PAST_RE);
  const markerIdx = m ? m.index : norm.length;
  const companyIdx = firstCompanyTokenIndex(norm, companyName);
  if (companyIdx !== -1 && companyIdx < markerIdx) return 'snippet';
  // "Previously at Google, now CTO at Acme" — a now/current transition before
  // the company mention means the role that follows is the current one.
  const nowMatch = norm.match(/ (?:now|currently|presently|joined) /);
  const nowIdx = nowMatch ? nowMatch.index : -1;
  if (companyIdx !== -1 && nowIdx !== -1 && companyIdx > nowIdx) return 'snippet';
  return 'past';
}

export function roleCurrency(inTitle, inSnippet, titleHay, snippetHay, companyName) {
  if (inTitle) {
    if (inSnippet && ROLE_PAST_RE.test(snippetHay || '')) return 'review-past';
    return 'current';
  }
  if (inSnippet) {
    return snippetCurrency(snippetHay, companyName);
  }
  return 'past';
}

export const ROLE_LABELS = {
  'current': 'Current',
  'snippet': 'Current (snippet)',
  'review-past': 'Review — possibly past'
};

// ------------------------------------------------- Hunter.io email matching ----

function cleanNamePart(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Match a person against emails found by Hunter.io for the company domain.
 * @param {string} fullName
 * @param {Array} hunterEmails  [{value, first_name, last_name, position}]
 * @param {string|null} patternTemplate  Hunter's verified domain pattern, e.g. "{first}.{last}"
 * @param {string|null} domain           corporate domain for the pattern fallback
 * @returns {{email:string, status:string}|null}
 */
export function matchHunterEmail(fullName, hunterEmails, patternTemplate, domain) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(p => /[A-Za-z]/.test(p));
  if (!parts.length) return null;
  const first = cleanNamePart(parts[0]);
  const last = cleanNamePart(parts[parts.length - 1]);
  for (const e of (hunterEmails || [])) {
    if (!e || !e.value) continue;
    const hf = cleanNamePart(e.first_name);
    const hl = cleanNamePart(e.last_name);
    if (hf && hl && hf === first && hl === last) {
      return { email: e.value, status: 'verified via Hunter.io' };
    }
    const local = String(e.value).split('@')[0].toLowerCase();
    if (!local) continue;
    if (first && last && (
      local === first + '.' + last || local === first[0] + last ||
      local === first + last || local === first + '.' + last.charAt(0))) {
      return { email: e.value, status: 'matched via Hunter.io' };
    }
  }
  if (patternTemplate && domain) {
    const local = String(patternTemplate)
      .replace(/\{first_initial\}/gi, first ? first.charAt(0) : '')
      .replace(/\{last_initial\}/gi, last ? last.charAt(0) : '')
      .replace(/\{f\}/gi, first ? first.charAt(0) : '')
      .replace(/\{l\}/gi, last ? last.charAt(0) : '')
      .replace(/\{first\}/gi, first)
      .replace(/\{last\}/gi, last)
      .replace(/[^a-z0-9._\-]/gi, '');
    // accept any resolved local part with at least one letter — Hunter
    // patterns like "{first}{last}" contain no dot but are still verified
    if (local && /[a-z]/i.test(local)) {
      return { email: local + '@' + domain, status: 'pattern from Hunter.io (domain-verified)' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- emails ----

export function domainFromWebsite(website) {
  if (!website) return null;
  const m = String(website).trim().match(/^(?:https?:\/\/)?(?:[^@\/\s]+@)?([a-z0-9\-\.]+\.[a-z]{2,})/i);
  if (!m) return null;
  let host = m[1].toLowerCase().replace(/^www\./, '');
  if (/^(gmail|yahoo|hotmail|outlook|icloud|proton|rediffmail)\./.test(host)) return null; // not a corporate domain
  return host;
}

function cleanEmailPart(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Pattern-estimate the corporate email. ALWAYS flagged "estimated — unverified".
 * Returns { email, status, alternates } or null when no domain.
 */
export function emailFor(fullName, domain) {
  if (!domain || !fullName) return null;
  const parts = fullName.trim().split(/\s+/).filter(p => /[A-Za-z]/.test(p));
  if (parts.length < 1) return null;
  const first = cleanEmailPart(parts[0]);
  const last = cleanEmailPart(parts[parts.length - 1]);
  if (!first || !last) return null;
  const f = first.charAt(0);
  const candidates = [`${first}.${last}`, `${f}${last}`, `${first}${last}`, `${first}`, `${first}_${last}`, `${f}.${last}`];
  return {
    email: `${candidates[0]}@${domain}`,
    status: 'estimated — unverified',
    alternates: candidates.slice(1).map(c => `${c}@${domain}`)
  };
}

// ------------------------------------------------------------- exports ----

export function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

const CORE_HEAD = ['Name', 'Designation', 'Country', 'Company Name', 'Company Size', 'Industry', 'LinkedIn URL'];
const FULL_HEAD = CORE_HEAD.concat([
  'Email', 'Email Status', 'Role Currency', 'Priority', 'Verification', 'HQ', 'Company Page'
]);

function personRow(p, comp, extended) {
  const verify = p.urlVerified ? 'Verified' : (p.url ? 'Unverified URL' : 'Unverified');
  const row = [
    p.name, p.designation || '', comp.country || '', comp.name || '', comp.size || '',
    comp.industry || '', p.url || ''
  ];
  if (extended) {
    const roleTxt = ROLE_LABELS[p.currentEmployer] || '—';
    row.push(p.email || '', p.emailStatus || '', roleTxt, p.priority || '',
      verify, comp.hq || '', comp.url || '');
  }
  return row.map(cell).join('\t');
}

/**
 * Build the TSV. core=false adds Email / Email Status / Priority / Verification / Company Page.
 * One row per person; companies with zero people get a single review row.
 */
export function buildTSV(companies, { core = false } = {}) {
  const head = (core ? CORE_HEAD : FULL_HEAD).join('\t');
  const lines = [head];
  const sorted = [...companies].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  for (const comp of sorted) {
    const people = [...(comp.people || [])].sort((a, b) =>
      (a.priority || 9) - (b.priority || 9) || (b.score || 0) - (a.score || 0));
    if (!people.length) {
      const row = ['—', 'No decision-makers found — needs manual review', comp.country || '',
        comp.name || comp.input || '', comp.size || '', comp.industry || '', comp.url || ''];
      if (!core) row.push('', '', '', '', '', '', comp.url || '');
      lines.push(row.map(cell).join('\t'));
      continue;
    }
    for (const p of people) lines.push(personRow(p, comp, !core));
  }
  return lines.join('\n') + '\n';
}

/** Excel-friendly CSV (RFC-4180 quoting; caller prepends UTF-8 BOM). */
export function buildCSV(companies, { core = false } = {}) {
  const q = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = (core ? CORE_HEAD : FULL_HEAD);
  const lines = [head.join(',')];
  const tsv = buildTSV(companies, { core });
  const rows = tsv.split('\n').filter(Boolean);
  for (let i = 1; i < rows.length; i++) lines.push(rows[i].split('\t').map(q).join(','));
  return lines.join('\r\n') + '\r\n';
}

// --------------------------------------------------------------- misc -----

export function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
