// The scan-result card. Takes a verdict from js/core/verdict.js and returns HTML.
// Rules: every dynamic value is escaped; no green "all clear" styling; status is never shown by color alone
// (each state has its own icon and label); details live in a native <details> element so it works
// with screen readers and without any script.

import { escapeHtml as esc } from '../core/text.js';

const BADGES = {
  recall: ['RECALL', 'tri'],
  allergen_match: ['ALLERGEN MATCH', 'tri'],
  possible_recall: ['POSSIBLE RECALL', 'tri'],
  caution: ['MAY CONTAIN', 'bang'],
  unverified: ["COULDN'T VERIFY", 'q'],
  no_match_found: ['NO MATCH FOUND', 'i'],
};

const ADVICE = {
  recall: 'Do not eat it. Compare the lot code and best-by date on the package with the official notice, then follow its instructions (usually discard it or return it for a refund).',
  allergen_match: 'Do not serve this to the people listed. Read the package label to confirm.',
  possible_recall: 'Check the lot code and best-by date on the package against the notice before anyone eats it.',
  caution: 'Read the package label, including any "may contain" statement, before the people listed eat this.',
  unverified: 'Read the package label before eating this, or scan the barcode again.',
  no_match_found: 'This is not a guarantee. Read the package label, especially if anyone has a severe allergy.',
};

const OFFICIAL = [
  ['FDA recalls', 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts'],
  ['USDA FSIS recalls', 'https://www.fsis.usda.gov/recalls'],
];

const LEVEL_TEXT = { 'contains': 'Contains', 'may-contain': 'May contain', 'possible': 'Possible' };
const SOURCE_TEXT = {
  ingredients: 'in the ingredient list',
  declared: 'declared in the product data',
  'precautionary statement': 'in a "may contain" or shared-facility statement',
  'product name': 'from the product name only',
};

const svg = (inner) => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
const ICONS = {
  tri: svg('<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.5v.01"/>'),
  bang: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
  q: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.01"/>'),
  i: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>'),
};

export function formatAgo(ts, now = Date.now()) {
  if (!ts) return 'never refreshed on this device';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 2) return 'just now';
  if (m < 90) return m + ' minutes ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' hours ago';
  return Math.round(h / 24) + ' days ago';
}

const names = (findings) => findings.map((f) => esc(f.label)).join(', ');

function chip(p) {
  const hard = p.findings.filter((f) => f.level === 'contains');
  const soft = p.findings.filter((f) => f.level !== 'contains');
  let text;
  if (p.status === 'allergen_match') text = 'Contains ' + names(hard) + (soft.length ? '; may contain ' + names(soft) : '');
  else if (p.status === 'caution') text = 'May contain ' + names(soft.length ? soft : p.findings);
  else if (p.status === 'unverified') text = "Couldn't verify allergens";
  else text = 'No allergen match found';
  return '<li class="rk-chip rk-chip-' + esc(p.status) + '"><span class="rk-chip-name">' + esc(p.name || 'Profile') + '</span><span class="rk-chip-state">' + text + '</span></li>';
}

function recallDetails(verdict) {
  const out = [];
  for (const m of verdict.recall.matches) {
    const r = m.record || {};
    const rows = [];
    if (r.title || r.product) rows.push('<strong>' + esc(r.title || r.product) + '</strong>');
    rows.push(m.confidence === 'exact' ? 'Matched by barcode.' : esc(m.note || 'Possible match.'));
    if (r.severity) rows.push('Severity: ' + esc(r.severity));
    if (r.recallDate) rows.push('Date: ' + esc(r.recallDate));
    if (r.hazard) rows.push('Hazard: ' + esc(r.hazard));
    if (r.action) rows.push('What the notice says to do: ' + esc(r.action));
    if (Array.isArray(r.stores) && r.stores.length) rows.push('Sold at: ' + esc(r.stores.join(', ')));
    out.push('<li>' + rows.join('<br>') + '</li>');
  }
  return out.length ? '<p class="rk-h">Recall match</p><ul>' + out.join('') + '</ul>' : '';
}

function allergenDetails(verdict) {
  if (!verdict.findings.length) return '';
  const rows = verdict.findings.map((f) =>
    '<li>' + esc(f.label) + ': ' + esc(LEVEL_TEXT[f.level] || f.level).toLowerCase() + ' ' + esc(SOURCE_TEXT[f.source] || f.source) +
    (f.evidence && f.evidence.length ? ' (' + f.evidence.map(esc).join(', ') + ')' : '') + '</li>');
  return '<p class="rk-h">What was found in the product data</p><ul>' + rows.join('') + '</ul>';
}

export function renderVerdictCard({ verdict, screeningNote = '', lastSyncTimestamp = null, terminated = false, now = Date.now() } = {}) {
  if (!verdict || !BADGES[verdict.status]) return '';
  const status = verdict.status;
  const [label, icon] = BADGES[status];
  const urgent = status === 'recall' || status === 'allergen_match' || status === 'possible_recall';

  let detail = verdict.detail;
  if (status === 'no_match_found' && !verdict.screenedAllergens) detail = 'No active recall was found in the data on this device. Allergens were not checked.';

  const screenedProfiles = verdict.perProfile.filter((p) => p.screened);
  const noneChecked = screenedProfiles.length > 0 && screenedProfiles.every((p) => p.status === 'unverified');
  // If nobody could be checked, say it once instead of repeating it for every profile.
  const chips = noneChecked ? [] : screenedProfiles.map(chip);
  if (noneChecked && status === 'unverified') detail = 'There is not enough trusted data to check this product, so allergens could not be checked for anyone in your household.';
  // For allergen/caution cards the per-person rows already say who and what, so don't repeat it in a sentence.
  const showDetail = !((status === 'allergen_match' || status === 'caution') && chips.length);
  const people = chips.length ? '<ul class="rk-people" aria-label="Results for each person">' + chips.join('') + '</ul>' : '';
  const note = !verdict.screenedAllergens && screeningNote ? '<p class="rk-note">' + esc(screeningNote) + '</p>' : '';

  const quality = verdict.dataQuality.reasons.length ? '<p class="rk-h">Data limits</p><ul>' + verdict.dataQuality.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '';
  const fresh = '<p class="rk-h">Recall data</p><p>Last refreshed ' + esc(formatAgo(lastSyncTimestamp, now)) + '. Covers FDA and USDA notices only.</p>';
  const ended = terminated ? '<p class="rk-note">An earlier recall notice for this product has ended.</p>' : '';
  const links = (status === 'recall' || status === 'possible_recall')
    ? '<p class="rk-links">Official notices: ' + OFFICIAL.map(([t, u]) => '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + '</a>').join(' | ') + '</p>' : '';

  return '<section class="rk-card rk-' + status + '" data-rk-status="' + status + '" role="' + (urgent ? 'alert' : 'status') + '">' +
    '<div class="rk-badge"><span class="rk-ico">' + ICONS[icon] + '</span><span>' + esc(label) + '</span></div>' +
    '<h3 class="rk-headline">' + esc(verdict.headline) + '</h3>' +
    (showDetail ? '<p class="rk-detail">' + esc(detail) + '</p>' : '') + people + note + ended +
    '<p class="rk-next"><strong>What to do:</strong> ' + esc(ADVICE[status]) + '</p>' + links +
    '<details class="rk-why"><summary>Why this result</summary>' + recallDetails(verdict) + allergenDetails(verdict) + quality + fresh + '</details>' +
    '<p class="rk-fine">' + esc(verdict.disclaimer) + '</p></section>';
}

export const CARD_CSS = `
.rk-card{--rk-bg:#0f172a;--rk-fg:#f1f5f9;--rk-sub:#cbd5e1;--rk-line:#334155;--rk-accent:#94a3b8;--rk-ink:#0b1220;--rk-tint:rgba(148,163,184,.14);
  border:1px solid var(--rk-accent);border-left-width:6px;border-radius:16px;background:linear-gradient(var(--rk-tint),var(--rk-tint)),var(--rk-bg);
  color:var(--rk-fg);padding:14px 16px;font-size:15px;line-height:1.45;text-align:left}
.rk-recall{--rk-accent:#f43f5e;--rk-tint:rgba(244,63,94,.16)}
.rk-allergen_match{--rk-accent:#fb923c;--rk-tint:rgba(251,146,60,.15)}
.rk-possible_recall{--rk-accent:#f59e0b;--rk-tint:rgba(245,158,11,.14)}
.rk-caution{--rk-accent:#eab308;--rk-tint:rgba(234,179,8,.12)}
.rk-unverified{--rk-accent:#94a3b8;--rk-tint:rgba(148,163,184,.14)}
.rk-no_match_found{--rk-accent:#38bdf8;--rk-tint:rgba(56,189,248,.10)}
.rk-badge{display:inline-flex;align-items:center;gap:6px;background:var(--rk-accent);color:var(--rk-ink);font-weight:800;font-size:13px;letter-spacing:.06em;padding:4px 10px 4px 8px;border-radius:999px}
.rk-ico{display:inline-flex}
.rk-headline{margin:10px 0 4px;font-size:18px;font-weight:700;line-height:1.3;color:var(--rk-fg)}
.rk-detail{margin:0 0 8px;color:var(--rk-sub)}
.rk-people{list-style:none;margin:8px 0;padding:0;display:flex;flex-direction:column;gap:6px}
.rk-chip{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;border:1px solid var(--rk-line);border-radius:12px;padding:8px 10px;background:rgba(2,6,23,.35)}
.rk-chip-name{font-weight:700}
.rk-chip-state{color:var(--rk-sub)}
.rk-chip-allergen_match{border-color:#fb923c}.rk-chip-caution{border-color:#eab308}
.rk-note{margin:6px 0;padding:8px 10px;border:1px dashed var(--rk-line);border-radius:10px;color:var(--rk-sub)}
.rk-next{margin:10px 0 6px}
.rk-links{margin:6px 0;color:var(--rk-sub)}
.rk-links a{color:inherit;text-decoration:underline;font-weight:600}
.rk-why{margin:8px 0;border-top:1px solid var(--rk-line);padding-top:8px}
.rk-why summary{cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center}
.rk-why p,.rk-why ul{margin:4px 0;color:var(--rk-sub)}
.rk-why ul{padding-left:18px}
.rk-h{font-weight:700;color:var(--rk-fg)!important;margin-top:10px!important}
.rk-fine{margin:8px 0 0;font-size:13px;color:var(--rk-sub)}
html.theme-light .rk-card{--rk-bg:#ffffff;--rk-fg:#0f172a;--rk-sub:#334155;--rk-line:#cbd5e1;--rk-ink:#ffffff}
html.theme-light .rk-chip{background:rgba(15,23,42,.04)}
html.theme-light .rk-recall{--rk-accent:#be123c;--rk-tint:rgba(190,18,60,.07)}
html.theme-light .rk-allergen_match{--rk-accent:#c2410c;--rk-tint:rgba(194,65,12,.07)}
html.theme-light .rk-possible_recall{--rk-accent:#b45309;--rk-tint:rgba(180,83,9,.07)}
html.theme-light .rk-caution{--rk-accent:#a16207;--rk-tint:rgba(161,98,7,.07)}
html.theme-light .rk-unverified{--rk-accent:#475569;--rk-tint:rgba(71,85,105,.07)}
html.theme-light .rk-no_match_found{--rk-accent:#0369a1;--rk-tint:rgba(3,105,161,.06)}
`;

export function injectStyles(doc) {
  if (!doc || doc.getElementById('rk-card-css')) return;
  const el = doc.createElement('style');
  el.id = 'rk-card-css';
  el.textContent = CARD_CSS;
  doc.head.appendChild(el);
}
