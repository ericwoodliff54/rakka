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
  return renderVerdictCard({ verdict, screeningNote, lastSyncTimestamp: ctx.lastSyncTimestamp || null, terminated: Boolean(data.terminatedNotice), now });
}

if (typeof window !== 'undefined') {
  injectStyles(document);
  window.RakkaSafety = { version: '1.0.0', cardHtmlFor, assessProduct, escapeHtml };
}
export { cardHtmlFor };
