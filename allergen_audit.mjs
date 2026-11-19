// RAKKA allergen detection audit.
//   1. A fixed battery of tricky ingredient lists with known answers (must-catch and must-not-flag).
//   2. The whole offline catalog: compare what the app's detector finds in each ingredient list with the allergens the
//      manufacturer/database declared for that product. Disagreements are listed so a person can look.
// Uses the app's real detection code (js/core/allergens.js). Fails the run only if a must-catch case is missed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeAllergens, normalizeAllergenId, ALLERGEN_IDS } from './js/core/allergens.js';

const lvl = (r, id) => (r.findings.find((f) => f.allergen === id) || {}).level;
const flags = [];
const flag = (level, text) => flags.push({ level, text });

// ---- 1. Battery. catch = must be "contains" (or at least flagged); not = must NOT be flagged at all.
const B = [
  ['whey and casein', 'Whey protein concentrate, sodium caseinate, natural flavor', { catch: ['dairy'] }],
  ['ghee and lactose', 'Clarified butter (ghee), lactose, salt', { catch: ['dairy'] }],
  ['buttermilk powder', 'Enriched flour, buttermilk powder, sugar', { catch: ['dairy', 'gluten'] }],
  ['cheese cultures', 'Pasteurized part-skim milk, cheese cultures, salt, enzymes', { catch: ['dairy'] }],
  ['ovalbumin and lysozyme', 'Sugar, ovalbumin, lysozyme, citric acid', { catch: ['eggs'] }],
  ['mayonnaise', 'Soybean oil, water, egg yolks, vinegar, mayonnaise', { catch: ['eggs', 'soy'] }],
  ['tamari and miso', 'Water, tamari, miso paste, rice', { catch: ['soy'] }],
  ['soy lecithin', 'Cocoa mass, sugar, soy lecithin, vanilla', { catch: ['soy'] }],
  ['edamame and tofu', 'Edamame, tofu, sesame oil', { catch: ['soy', 'sesame'] }],
  ['tahini', 'Chickpeas, tahini, lemon juice, garlic', { catch: ['sesame'] }],
  ['hazelnut and almond', 'Hazelnuts, almond paste, sugar', { catch: ['treenuts'] }],
  ['pecans and walnuts', 'Pecans, walnuts, maple syrup', { catch: ['treenuts'] }],
  ['peanut oil and flour', 'Peanut flour, refined peanut oil, salt', { catch: ['peanuts'] }],
  ['groundnuts', 'Groundnuts, salt', { catch: ['peanuts'] }],
  ['surimi', 'Alaska pollock, surimi, crab flavor, wheat starch', { catch: ['fish', 'gluten'] }],
  ['anchovy and worcestershire', 'Vinegar, molasses, anchovies, Worcestershire sauce', { catch: ['fish'] }],
  ['shrimp and crab', 'Shrimp, crab meat, lobster stock', { catch: ['shellfish'] }],
  ['oysters and clams', 'Clam juice, oyster extract, salt', { catch: ['shellfish'] }],
  ['semolina and durum', 'Durum wheat semolina, niacin', { catch: ['gluten'] }],
  ['malt and barley', 'Barley malt extract, rye flour, sugar', { catch: ['gluten'] }],
  ['spelt and farro', 'Spelt flour, farro, water', { catch: ['gluten'] }],
  ['sulfites', 'Dried apricots, sulfur dioxide, potassium metabisulfite', { catch: ['sulfites'] }],
  ['yeast extract', 'Water, autolyzed yeast extract, salt', { catch: ['yeast'] }],
  ['corn products', 'Corn syrup, cornstarch, corn meal, popcorn', { catch: ['corn'] }],
  ['contains statement', 'Sugar, flour. CONTAINS: MILK, EGG, WHEAT, SOY.', { catch: ['dairy', 'eggs', 'gluten', 'soy'] }],
  ['may contain statement', 'Sugar, cocoa. May contain peanuts and tree nuts.', { catch: ['peanuts', 'treenuts'] }],
  ['butter and cream', 'Cream, butter, salt', { catch: ['dairy'] }],
  ['ice cream', 'Skim milk, cream, sugar, egg yolks', { catch: ['dairy', 'eggs'] }],
  ['egg noodles', 'Enriched wheat flour, egg whites, water', { catch: ['eggs', 'gluten'] }],
  // false-positive guards
  ['cocoa butter and shea', 'Cocoa butter, shea butter, sugar', { not: ['dairy'] }],
  ['peanut butter is not dairy', 'Roasted peanuts, peanut butter, salt', { not: ['dairy'] }],
  ['eggplant', 'Eggplant, olive oil, salt', { not: ['eggs'] }],
  ['peppercorns', 'Black peppercorns, sea salt', { not: ['corn'] }],
  ['butter beans', 'Butter beans, water, salt', { not: ['dairy'] }],
  ['coconut is not a tree nut here', 'Coconut milk, water, guar gum', { not: ['dairy'] }],
  ['almond milk is not dairy', 'Filtered water, almonds, sea salt', { not: ['dairy'] }],
  ['buckwheat is not wheat', 'Buckwheat flour, water, salt', { not: ['gluten'] }],
  ['gluten free claim', 'Rice flour, tapioca starch. Gluten free. Dairy free.', { not: ['gluten', 'dairy'] }],
  ['sunflower lecithin', 'Sunflower lecithin, sugar', { not: ['soy'] }],
  ['cream of tartar', 'Baking soda, cream of tartar', { not: ['dairy'] }],
  ['romano beans are not cheese', 'Zucchini, romano beans, carrots', { not: ['dairy'] }],
  ['oyster mushrooms are not shellfish', 'Dried oyster mushrooms, salt', { not: ['shellfish'] }],
  ['romano cheese still dairy', 'Romano cheese, parsley', { catch: ['dairy'] }],
  ['oyster sauce still shellfish', 'Water, oyster extract, sugar, salt', { catch: ['shellfish'] }],
  ['plain water and salt', 'Water, sea salt', { not: ALLERGEN_IDS }],
];
const batteryFail = [];
for (const [name, ing, exp] of B) {
  const r = analyzeAllergens({ ingredients: ing });
  for (const id of exp.catch || []) { const l = lvl(r, id); if (!l) batteryFail.push({ name, kind: 'MISSED', allergen: id, ing }); }
  for (const id of exp.not || []) { const l = lvl(r, id); if (l) batteryFail.push({ name, kind: 'FALSE ALARM', allergen: id, ing, got: l }); }
}
const missed = batteryFail.filter((f) => f.kind === 'MISSED');
if (missed.length) flag('bad', `${missed.length} must-catch allergen case(s) were MISSED by the detector (see list). These are safety-critical.`);
if (batteryFail.length - missed.length) flag('warn', `${batteryFail.length - missed.length} false-alarm guard case(s) failed.`);

// ---- 2. Catalog comparison
let items = [];
try { items = JSON.parse(zlib.gunzipSync(fs.readFileSync('community_catalog.json.gz'))).items || []; } catch (e) { flag('warn', 'Could not read the catalog: ' + e.message); }
const perId = {}; for (const id of ALLERGEN_IDS) perId[id] = { declared: 0, caught: 0, missed: [], extra: [] };
let tested = 0;
const seen = new Set();
for (const it of items) {
  const ing = String(it.ingredients || '').trim();
  if (ing.length < 15) continue;
  const k = String(it.upc || '').replace(/^0+/, '');
  if (seen.has(k)) continue; seen.add(k);
  tested++;
  const declared = new Set((it.allergens || []).map(normalizeAllergenId).filter(Boolean));
  const r = analyzeAllergens({ ingredients: ing, name: '' });
  for (const id of ALLERGEN_IDS) {
    const found = ['contains', 'may-contain'].includes(lvl(r, id)) || lvl(r, id) === 'possible';
    const strong = lvl(r, id) === 'contains';
    if (declared.has(id)) { perId[id].declared++; if (found) perId[id].caught++; else if (perId[id].missed.length < 8) perId[id].missed.push({ name: `${it.brand || ''} ${it.name || ''}`.trim().slice(0, 70), ing: ing.slice(0, 160) }); }
    else if (strong && perId[id].extra.length < 6) perId[id].extra.push({ name: `${it.brand || ''} ${it.name || ''}`.trim().slice(0, 70), ing: ing.slice(0, 160) });
  }
}
const rows = ALLERGEN_IDS.map((id) => ({ id, ...perId[id], pct: perId[id].declared ? Math.round((100 * perId[id].caught) / perId[id].declared) : null }));
for (const r of rows) if (r.declared >= 20 && r.pct < 85) flag('warn', `${r.id}: the detector found only ${r.pct}% of products that declare it (${r.caught} of ${r.declared}). Examples below.`);
const level = flags.some((f) => f.level === 'bad') ? 'ACTION NEEDED' : flags.some((f) => f.level === 'warn') ? 'Review' : 'All clear';

const L = [`RAKKA allergen audit: ${level}`, '', ...flags.map((f) => `- [${f.level}] ${f.text}`), '',
  `Battery: ${B.length - new Set(batteryFail.map((f) => f.name)).size} of ${B.length} cases passed`, ...batteryFail.map((f) => `  ${f.kind}: ${f.allergen} in "${f.name}" -> ${f.ing}`), '',
  `Catalog comparison (${tested} products with ingredient lists). "caught" = detector found the allergen the product declares:`,
  ...rows.map((r) => `  ${r.id.padEnd(10)} declared ${String(r.declared).padStart(5)}  caught ${r.pct === null ? 'n/a' : r.pct + '%'}`), ''];
for (const r of rows) if (r.missed.length && r.pct !== null && r.pct < 95) { L.push(`Declared but NOT found (often the database lists "may contain" traces that are not in the ingredient list) by the detector: ${r.id}`); r.missed.forEach((m) => L.push(`  ${m.name}: ${m.ing}`)); L.push(''); }
for (const r of rows) if (r.extra.length) { L.push(`Detector says "contains ${r.id}" but the product does not declare it (could be an under-declared label or a false alarm):`); r.extra.slice(0, 4).forEach((m) => L.push(`  ${m.name}: ${m.ing}`)); L.push(''); }
const txt = L.join('\n');
fs.writeFileSync('allergen_report.txt', txt);
fs.writeFileSync('allergen_report.html', `<pre style="font-family:ui-monospace,monospace;font-size:13px">${txt.replace(/[&<]/g, (c) => ({ '&': '&amp;', '<': '&lt;' }[c]))}</pre>`);
fs.writeFileSync('allergen_result.json', JSON.stringify({ level, flags, rows: rows.map(({ missed, extra, ...x }) => x) }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + txt + '\n```\n');
console.log(txt);
if (missed.length) process.exit(1);
