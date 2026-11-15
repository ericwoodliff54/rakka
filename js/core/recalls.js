// Recall matching. A recall is only ever dismissed by the person (a visible, undoable action in the UI),
// never by a hardcoded exception in this file.

import { normalizeBarcode } from './gtin.js';
import { normalizeText, phraseRegex } from './text.js';

const INACTIVE = /terminat|complet|closed|ended|resolved/i;
export const isActiveRecall = (r) => !INACTIVE.test(String(r.status || ''));

const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** buildRecallIndex(records): record = { id, title, brand, brands[], keywords[], upcs[], agency, classification, status, ... } */
export function buildRecallIndex(records = []) {
  const idx = { records: [], byGtin: new Map(), byStem: new Map(), byShort: new Map(), textRecords: [] };
  const push = (map, key, rec) => { if (!map.has(key)) map.set(key, []); const arr = map.get(key); if (!arr.includes(rec)) arr.push(rec); };
  for (const rec of records) {
    if (!rec) continue;
    idx.records.push(rec);
    for (const code of [...toList(rec.upcs), ...toList(rec.upc), ...toList(rec.codes)]) {
      const nb = normalizeBarcode(code);
      for (const c of nb.candidates) { push(idx.byGtin, c.gtin14, rec); push(idx.byStem, c.stem, rec); }
      if (nb.shortCode) push(idx.byShort, nb.shortCode, rec);
    }
    const brands = [...new Set([rec.brand, ...toList(rec.brands)].filter(Boolean).map(normalizeText))];
    const keywords = [...new Set(toList(rec.keywords).map(normalizeText).filter(Boolean))];
    if (brands.length && keywords.length) idx.textRecords.push({ rec, brandRe: phraseRegex(brands), keywords });
  }
  return idx;
}

/** matchBarcode(raw, index, {activeOnly}) -> [{ record, confidence:'exact'|'near', note }] */
export function matchBarcode(raw, index, { activeOnly = true } = {}) {
  const nb = normalizeBarcode(raw);
  const results = new Map();
  const add = (record, confidence, note) => {
    if (activeOnly && !isActiveRecall(record)) return;
    const cur = results.get(record);
    if (!cur || (cur.confidence === 'near' && confidence === 'exact')) results.set(record, { record, confidence, note });
  };
  for (const c of nb.candidates) {
    for (const r of index.byGtin.get(c.gtin14) || []) add(r, 'exact', '');
    for (const r of index.byStem.get(c.stem) || []) add(r, 'near', 'Same product code but the check digit differs; the barcode may have been misread.');
  }
  if (nb.shortCode) for (const r of index.byShort.get(nb.shortCode) || []) add(r, 'exact', '');
  return [...results.values()];
}

/** matchByText({name, brand}, index) -> possible matches only (never "exact"); needs brand AND product words. */
export function matchByText({ name = '', brand = '' } = {}, index, { activeOnly = true } = {}) {
  const text = normalizeText(`${brand} ${name}`);
  if (!text) return [];
  const out = [];
  for (const { rec, brandRe, keywords } of index.textRecords) {
    if (activeOnly && !isActiveRecall(rec)) continue;
    const b = text.match(brandRe);
    if (!b) continue;
    const hits = keywords.filter((k) => phraseRegex([k], '').test(text));
    if (hits.length >= 2 || hits.some((k) => k.includes(' '))) {
      out.push({ record: rec, confidence: 'possible', evidence: { brand: b[0], keywords: hits }, note: 'Matched by brand and product words, not by barcode. Check the lot code and best-by date.' });
    }
  }
  return out;
}
