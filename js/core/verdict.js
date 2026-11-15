// Turns allergen findings + recall matches + data quality into ONE honest result per product.
// Design rules:
//  1. Never claim a product is "safe". The best outcome is NO_MATCH: "nothing found in the data we have".
//  2. Unverified or missing data can only RAISE concern, never lower it.
//  3. If we could not read the ingredients, the answer is UNVERIFIED, not "clear".

import { analyzeAllergens, normalizeAllergenId } from './allergens.js';

export const STATUS = Object.freeze({
  RECALL: 'recall',
  ALLERGEN: 'allergen_match',
  POSSIBLE_RECALL: 'possible_recall',
  CAUTION: 'caution',
  UNVERIFIED: 'unverified',
  NO_MATCH: 'no_match_found',
});
const SEVERITY = { recall: 6, allergen_match: 5, possible_recall: 4, caution: 3, unverified: 2, no_match_found: 1 };
const STALE_FEED_MS = 72 * 60 * 60 * 1000;
export const DISCLAIMER = 'Always read the package label. Recall data covers FDA and USDA notices only.';

const worst = (a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b);
const labels = (findings) => findings.map((f) => f.label).join(', ');

/** Data quality for the allergen part of the answer. */
export function assessDataQuality(product, analysis) {
  const reasons = [];
  const src = String(product.dataSource || '').toLowerCase();
  if (analysis.ingredientData === 'none') reasons.push('No ingredient list available.');
  else if (analysis.ingredientData === 'thin') reasons.push('Ingredient list looks incomplete.');
  if (/community|receipt|name|unverified/.test(src) || product.unverified || product.communitySubmitted) reasons.push('Product data is community-submitted or inferred and has not been verified.');
  const level = analysis.ingredientData === 'none' ? 'none' : reasons.length ? 'partial' : 'full';
  return { level, reasons };
}

/**
 * assessProduct({ product, profiles, recallMatches, recallFeedUpdatedAt, now })
 *  product: { name, brand, barcode, ingredients, declaredAllergens, dataSource, unverified }
 *  profiles: [{ id, name, allergens: [ids] }]
 *  recallMatches: output of matchBarcode()/matchByText() (concatenated), or []
 */
export function assessProduct({ product = {}, profiles = [], recallMatches = [], recallFeedUpdatedAt = null, now = Date.now() } = {}) {
  const analysis = analyzeAllergens({ ingredients: product.ingredients, name: product.name, declared: product.declaredAllergens });
  const quality = assessDataQuality(product, analysis);
  const feedStale = recallFeedUpdatedAt == null || (now - recallFeedUpdatedAt) > STALE_FEED_MS;

  const exact = recallMatches.filter((m) => m.confidence === 'exact');
  const maybe = recallMatches.filter((m) => m.confidence !== 'exact');
  const recall = { status: exact.length ? 'recall' : maybe.length ? 'possible' : 'none', matches: recallMatches, feedStale };

  const perProfile = [];
  for (const p of profiles) {
    const wanted = new Set((p.allergens || []).map(normalizeAllergenId).filter(Boolean));
    if (!wanted.size) { perProfile.push({ profileId: p.id, name: p.name, status: null, findings: [], screened: false }); continue; }
    const rel = analysis.findings.filter((f) => wanted.has(f.allergen));
    const hard = rel.filter((f) => f.level === 'contains');
    const soft = rel.filter((f) => f.level !== 'contains');
    let status = STATUS.NO_MATCH;
    if (hard.length) status = STATUS.ALLERGEN;
    else if (soft.length) status = STATUS.CAUTION;
    else if (quality.level !== 'full') status = STATUS.UNVERIFIED;
    perProfile.push({ profileId: p.id, name: p.name, status, findings: rel, screened: true });
  }
  const screenedAny = perProfile.some((p) => p.screened);

  let status = STATUS.NO_MATCH;
  if (recall.status === 'recall') status = STATUS.RECALL;
  else if (recall.status === 'possible') status = worst(status, STATUS.POSSIBLE_RECALL);
  for (const p of perProfile) if (p.status) status = worst(status, p.status);
  if (!screenedAny && quality.level === 'none' && status === STATUS.NO_MATCH) status = STATUS.UNVERIFIED;
  if (feedStale && status === STATUS.NO_MATCH) status = STATUS.UNVERIFIED;

  const reasons = [...quality.reasons];
  if (feedStale) reasons.push('Recall data may be out of date. Refresh and check again.');
  return { status, ...describe(status, { recall, perProfile }), recall, perProfile, dataQuality: { ...quality, reasons }, findings: analysis.findings, screenedAllergens: screenedAny, disclaimer: DISCLAIMER };
}

function describe(status, { recall, perProfile }) {
  switch (status) {
    case STATUS.RECALL: {
      const t = recall.matches.find((m) => m.confidence === 'exact')?.record?.title;
      return { headline: t ? `Recalled: ${t}` : 'This product is recalled', detail: 'This barcode matches an active recall notice.' };
    }
    case STATUS.ALLERGEN: {
      const bad = perProfile.filter((p) => p.status === STATUS.ALLERGEN);
      return { headline: 'Contains an allergen on your list', detail: bad.map((p) => `${p.name}: ${labels(p.findings.filter((f) => f.level === 'contains'))}`).join('  |  ') };
    }
    case STATUS.POSSIBLE_RECALL:
      return { headline: 'Possible recall match', detail: 'Matched by brand and product words or a close barcode, not an exact barcode match.' };
    case STATUS.CAUTION: {
      const c = perProfile.filter((p) => p.status === STATUS.CAUTION);
      return { headline: 'May contain an allergen on your list', detail: c.map((p) => `${p.name}: ${labels(p.findings)}`).join('  |  ') };
    }
    case STATUS.UNVERIFIED:
      return { headline: "Couldn't fully verify", detail: 'There is not enough trusted data to check this product.' };
    default:
      return { headline: 'No match found in available data', detail: 'No recall or allergen match was found in the data on this device.' };
  }
}
