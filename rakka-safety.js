// Entry point loaded by index.html as <script type="module">.
// Exposes window.RakkaSafety so the existing (non-module) app code can ask for a result card.
// If this file fails to load, the app keeps using its legacy result windows.

import { assessProduct } from './core/verdict.js';
import { renderVerdictCard, injectStyles } from './ui/scanResultCard.js';
import { escapeHtml } from './core/text.js';

function recallMatchesFrom(data) {
  const rr = data && data.recallRecord;
  if (!(data && data.isRecalled && rr)) return [];
  return [{
    confidence: 'exact',
    record: {
      title: rr.product || data.productName || 'Recalled product',
      status: 'active',
      severity: rr.severity, recallDate: rr.recallDate, hazard: rr.hazard, action: rr.action, stores: rr.stores,
    },
  }];
}

/**
 * cardHtmlFor(data, ctx)
 *  data: the app's scan result object
 *  ctx:  { isPlus, profiles, lastSyncTimestamp, now? }
 */
function cardHtmlFor(data, ctx = {}) {
  const now = ctx.now || Date.now();
  const profiles = ctx.isPlus && Array.isArray(ctx.profiles)
    ? ctx.profiles.map((p) => ({ id: p.id, name: p.name, allergens: p.allergens || [] })) : [];
  const verdict = assessProduct({
    product: {
      name: data.productName, brand: data.brand, barcode: data.upc, ingredients: data.ingredients,
      // Older saved scans have no declaredAllergens; fall back to their saved allergen list (errs on the side of caution).
      declaredAllergens: Array.isArray(data.declaredAllergens) ? data.declaredAllergens : (Array.isArray(data.detectedAllergens) ? data.detectedAllergens : []),
      dataSource: data.productUnverified ? 'community' : '',
    },
    profiles,
    recallMatches: recallMatchesFrom(data),
    recallFeedUpdatedAt: ctx.lastSyncTimestamp || null,
    now,
  });
  let screeningNote = '';
  if (!ctx.isPlus) screeningNote = 'Allergen screening is a RAKKA Plus feature, so allergens were not checked against your household.';
  else if (!profiles.some((p) => p.allergens.length)) screeningNote = 'No allergens are selected in Allergen Guard, so allergens were not checked.';
  const html = renderVerdictCard({ verdict, screeningNote, lastSyncTimestamp: ctx.lastSyncTimestamp || null, terminated: Boolean(data.terminatedNotice), now });
  const extra = extraNotes(data, ctx);
  return extra ? html.replace('<p class="rk-next">', extra + '<p class="rk-next">') : html;
}

const stripZeros = (v) => String(v || '').replace(/\D/g, '').replace(/^0+/, '');

/** Notes shown under the verdict: a wrong-length code, and active recalls from the same brand (not a match for this code). */
function extraNotes(data, ctx) {
  if (!data || data.isRecalled) return '';
  const out = [];
  const digits = String(data.upc || '').replace(/\D/g, '');
  if (digits && ![8, 12, 13, 14].includes(digits.length)) {
    out.push('This code has ' + digits.length + ' digits. Barcodes normally have 12 (sometimes 8 or 13), so a digit may be missing or extra. Check the number and try again.');
  }
  const mine = stripZeros(digits);
  if (mine.length >= 6 && Array.isArray(ctx.recalls)) {
    const seen = new Set();
    const hits = [];
    for (const r of ctx.recalls) {
      if (!r || !Array.isArray(r.upcs)) continue;
      if (/terminat|complet|closed|ended|resolved/i.test(String(r.status || ''))) continue;
      if (!r.upcs.some((u) => stripZeros(u).slice(0, 6) === mine.slice(0, 6))) continue;
      const key = String(r.product || r.title || '');
      if (!key || seen.has(key)) continue;
      seen.add(key); hits.push(r);
      if (hits.length >= 2) break;
    }
    if (hits.length) {
      out.push('Active recall from the same brand: ' + hits.map((r) => escapeHtml(r.product || r.title) + (r.date ? ' (' + escapeHtml(r.date) + ')' : '')).join('; ') + '. That is not a match for this exact code, but check the package.');
    }
  }
  return out.map((t) => '<p class="rk-note">' + (t.indexOf('<') >= 0 ? t : escapeHtml(t)) + '</p>').join('');
}

if (typeof window !== 'undefined') {
  injectStyles(document);
  window.RakkaSafety = { version: '1.0.0', cardHtmlFor, assessProduct, escapeHtml };
}
export { cardHtmlFor };
