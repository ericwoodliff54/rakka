// Barcode normalisation. Turns whatever the scanner / receipt / database gives us into
// comparable GTIN-14 keys, and knows which differences are harmless (padding, a missing or
// misread check digit) so a recall is not missed because of formatting.

export const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');

export function checkDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(code) {
  return code.length >= 2 && checkDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

// UPC-E (8 digits, number system 0/1) -> 12-digit UPC-A, or null.
export function expandUpcE(code8) {
  if (!/^[01]\d{7}$/.test(code8)) return null;
  const ns = code8[0], chk = code8[7];
  const [d1, d2, d3, d4, d5, d6] = code8.slice(1, 7);
  let body;
  if ('012'.includes(d6)) body = ns + d1 + d2 + d6 + '0000' + d3 + d4 + d5;
  else if (d6 === '3') body = ns + d1 + d2 + d3 + '00000' + d4 + d5;
  else if (d6 === '4') body = ns + d1 + d2 + d3 + d4 + '00000' + d5;
  else body = ns + d1 + d2 + d3 + d4 + d5 + '0000' + d6;
  return body + chk;
}

/**
 * normalizeBarcode(raw) ->
 *  { digits, candidates:[{gtin14, stem, kind, note}], validCheckDigit, shortCode, notes }
 * - candidates: every plausible GTIN-14 reading (an 8-digit code may be EAN-8 or UPC-E).
 * - stem: the first 13 digits of the GTIN-14. Two codes with the same stem but different
 *   check digits are the same product misread, so they are reported as a "near" match.
 * - shortCode: codes under 8 digits (store item codes) are never padded, exact match only.
 */
export function normalizeBarcode(raw) {
  const digits = digitsOnly(raw);
  const out = { raw: String(raw ?? ''), digits, candidates: [], validCheckDigit: false, shortCode: null, notes: [] };
  if (!digits) return out;

  const add = (gtin, kind, note = '') => {
    const g14 = gtin.padStart(14, '0');
    if (!out.candidates.some((c) => c.gtin14 === g14)) out.candidates.push({ gtin14: g14, stem: g14.slice(0, 13), kind, note });
  };
  const L = digits.length;

  if (L < 8 || L === 9 || L === 10 || L > 14) {
    out.shortCode = digits;
    if (L >= 8) out.notes.push('Unrecognised barcode length; exact match only.');
    return out;
  }
  if (L === 8) {
    const upca = expandUpcE(digits);
    if (hasValidCheckDigit(digits)) { add(digits, 'ean8'); out.validCheckDigit = true; }
    if (upca && hasValidCheckDigit(upca)) { add(upca, 'upce'); out.validCheckDigit = true; }
    if (!out.candidates.length) { add(digits, 'ean8', 'invalid check digit'); if (upca) add(upca, 'upce', 'invalid check digit'); }
  } else if (L === 11) {
    add(digits + checkDigit(digits), 'upca', 'check digit computed');
    out.validCheckDigit = true;
    out.notes.push('Barcode had 11 digits; check digit was computed.');
  } else {
    out.validCheckDigit = hasValidCheckDigit(digits);
    add(digits, L === 12 ? 'upca' : L === 13 ? 'ean13' : 'gtin14', out.validCheckDigit ? '' : 'invalid check digit');
    if (!out.validCheckDigit) out.notes.push('Check digit does not validate; the barcode may have been misread. Rescan.');
  }
  return out;
}
