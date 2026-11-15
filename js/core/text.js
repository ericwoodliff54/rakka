// Small text helpers shared by the safety modules. No dependencies.

export function normalizeText(value) {
  return String(value ?? '')
    // Broken UTF-8 (a mangled dagger footnote mark after "peanuts", for example) glues junk onto the word
    // before it and hides allergen words. Replace the whole broken sequence with a space BEFORE anything else.
    .replace(/[\u00C2\u00C3\u00E2\u00E3][\u0080-\u00BF]+/g, ' ')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, '')                  // curly apostrophes: baker’s -> bakers
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^\x00-\x7f]/g, ' ')                     // anything else non-ASCII becomes a space
    .replace(/['`]/g, '')                              // brewer's -> brewers
    .replace(/[-_/]/g, ' ')                            // gluten-free -> gluten free
    .replace(/[()[\]{}*]/g, ' ')                      // flour (wheat) -> flour  wheat
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds a whole-word regex from plain phrases ("sour cream" -> sour\s+cream, plural optional).
export function phraseRegex(phrases, flags = 'g') {
  if (!phrases || !phrases.length) return null;
  const alts = phrases.map((p) => escapeRegex(normalizeText(p)).replace(/\s+/g, '\\s+') + '(?:s|es)?');
  return new RegExp('\\b(?:' + alts.join('|') + ')\\b', flags);
}
