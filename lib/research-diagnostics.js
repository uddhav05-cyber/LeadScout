export function researchSummary(company) {
  if (company.status === 'working') return 'Research in progress';
  const d = company.diagnostics;
  if (!d) return 'No decision-makers found. Retry to capture search diagnostics.';
  const parts = [d.resolution === 'unresolved' ? 'Company page unresolved' : 'Company page: ' + d.resolution];
  const lookup = d.resolutionSearch;
  if (d.resolution === 'unresolved' && (lookup.results || lookup.unreadable || lookup.consent ||
      lookup.verification || lookup.errors)) {
    parts.push('Company lookup: ' + lookup.results + ' Bing results' +
      (lookup.unreadable || lookup.consent || lookup.verification || lookup.errors ? ', some searches blocked or unreadable' : ''));
  }
  const b = d.peopleSearch;
  parts.push('Bing: ' + b.results + ' results, ' + b.profiles + ' distinct profile links');
  if (b.errors || b.consent || b.verification || b.unreadable) {
    const problems = [];
    if (b.errors) problems.push(b.errors + ' failed');
    if (b.consent) problems.push(b.consent + ' consent/interstitial');
    if (b.verification) problems.push(b.verification + ' verification');
    if (b.unreadable) problems.push(b.unreadable + ' unreadable');
    parts.push('Bing searches: ' + problems.join(', '));
  }
  const rejected = Object.entries(d.rejected).filter(([, count]) => count > 0);
  if (rejected.length) parts.push('Rejected entries: ' + rejected.map(([reason, count]) => count + ' ' + reason).join(', '));
  parts.push('AI: ' + d.ai);
  if (company.status === 'paused') parts.push('Paused');
  if (company.status === 'failed') parts.push('Research failed');
  return parts.join(' · ');
}
