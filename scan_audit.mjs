// RAKKA first-scan coverage audit.
// Asks: when a brand-new user scans a product for the first time, do they get a real name and ingredients (not "Retail Grocery Item")?
//   A. Regression: 150 random products from the offline catalog, looked up through the live worker (12- and 13-digit forms).
//   B. Real world: the most-scanned US products on Open Food Facts, looked up through the live worker.
// Writes scan_report.txt / scan_report.html / scan_result.json and the run Summary. Fails the run only for a real regression.
import fs from 'node:fs';
import zlib from 'node:zlib';

const WORKER = (process.env.WORKER_URL || 'https://rakka-edge.ericwoodliff.workers.dev').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flags = [];
const flag = (level, text) => flags.push({ level, text });

async function lookup(upc) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${WORKER}/lookup?upc=${upc}`, { signal: AbortSignal.timeout(25000), headers: { Origin: 'https://ericwoodliff54.github.io' } });
    const ms = Date.now() - t0;
    if (r.status === 404) { let diag = ''; try { diag = JSON.stringify((await r.json()).diag || ''); } catch (_) {} return { ok: true, found: false, ms, name: '', notFound: true, diag }; }
    if (!r.ok) return { ok: false, ms, err: 'HTTP ' + r.status };
    const j = await r.json();
    const p = j && j.product;
    const name = p && p.name ? String(p.name) : '';
    const good = !!(j && j.found && name && !/^retail grocery item/i.test(name));
    return { ok: true, found: good, ms, name, brand: p && p.brand, hasIngredients: !!(p && p.ingredients && String(p.ingredients).trim().length > 3), source: j && j.source };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: String(e.message || e) }; }
}
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ---- A. Catalog regression
let items = [];
try { items = JSON.parse(zlib.gunzipSync(fs.readFileSync('community_catalog.json.gz'))).items || []; } catch (e) { flag('warn', 'Could not read the offline catalog: ' + e.message); }
const rng = (() => { let s = Date.now() % 2147483647; return () => (s = (s * 48271) % 2147483647) / 2147483647; })();
const sampleA = [...items].sort(() => rng() - 0.5).slice(0, 150);
const A = { total: 0, found: 0, ingr: 0, errs: 0, ms: [], miss: [], errKinds: {} };
for (const it of sampleA) {
  const d = String(it.upc || '').replace(/\D/g, '');
  if (d.length < 8) continue;
  const form = A.total % 2 ? d.replace(/^0+/, '').padStart(13, '0') : d.replace(/^0+/, '').padStart(12, '0');
  const r = await lookup(form);
  A.total++;
  if (!r.ok) { A.errs++; A.errKinds[r.err] = (A.errKinds[r.err] || 0) + 1; continue; }
  A.ms.push(r.ms);
  if (r.found) { A.found++; if (r.hasIngredients) A.ingr++; } else A.miss.push({ upc: form, name: it.name });
  await sleep(120);
}
const aPct = pct(A.found, A.total - A.errs);

// ---- B. Most-scanned US products on Open Food Facts (a fair picture of what new users will scan)
const B = { total: 0, found: 0, ingr: 0, errs: 0, ms: [], miss: [], errKinds: {} };
let offList = [];
try {
  const u = 'https://world.openfoodfacts.org/api/v2/search?countries_tags_en=united-states&sort_by=unique_scans_n&page_size=120&fields=code,product_name,brands';
  const r = await fetch(u, { signal: AbortSignal.timeout(40000), headers: { 'User-Agent': 'RAKKA-audit/1.0 (contact@twinravensdigital.com)' } });
  if (r.ok) offList = ((await r.json()).products || []).filter((p) => p.code && /^\d{8,14}$/.test(p.code) && p.product_name);
} catch (e) { flag('warn', 'Open Food Facts popular-product list could not be fetched: ' + e.message); }
for (const p of offList.slice(0, 100)) {
  const r = await lookup(p.code);
  B.total++;
  if (!r.ok) { B.errs++; B.errKinds[r.err] = (B.errKinds[r.err] || 0) + 1; continue; }
  B.ms.push(r.ms);
  if (r.found) { B.found++; if (r.hasIngredients) B.ingr++; } else B.miss.push({ upc: p.code, name: `${p.brands || ''} ${p.product_name}`.trim(), diag: r.diag, ms: r.ms });
  await sleep(250);
}
const bPct = pct(B.found, B.total - B.errs);
// For popular products the worker could not find: does Open Food Facts itself have them? If yes, the worker is failing to reach it.
let offHas = 0, offChecked = 0;
for (const m of B.miss.slice(0, 40)) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${m.upc}.json`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'RAKKA-audit/1.0 (contact@twinravensdigital.com)' } });
    if (r.ok) { const j = await r.json(); offChecked++; if (j && j.status === 1 && j.product && (j.product.product_name || j.product.generic_name)) { offHas++; m.offHas = true; } }
  } catch (_) {}
  await sleep(700);
}


// ---- Verdict
const level0 = () => (flags.some((f) => f.level === 'bad') ? 'ACTION NEEDED' : flags.some((f) => f.level === 'warn') ? 'Review' : 'All clear');
if (A.total && A.errs / A.total > 0.2) flag('bad', `${A.errs} of ${A.total} catalog lookups failed to reach the worker (errors or timeouts).`);
if (A.total - A.errs >= 30 && aPct < 90) flag('bad', `Only ${aPct}% of products already in the catalog came back with a real name from the worker. This should be near 100%. Something may be wrong with barcode variants or the community database.`);
if (B.total - B.errs >= 30 && bPct < 75) flag('warn', `Only ${bPct}% of the most-scanned US products returned a real name. New users would see "Retail Grocery Item" for the rest.`);
if (A.ms.length && median(A.ms) > 1500) flag('warn', `Median lookup time for known products was ${median(A.ms)} ms. It should be well under a second.`);
if (!A.total) flag('warn', 'No catalog products were tested.');
if (B.total && B.errs / B.total > 0.2) flag('warn', `${B.errs} of ${B.total} popular-product lookups failed outright (${JSON.stringify(B.errKinds)}).`);
if (offChecked >= 5 && offHas / offChecked > 0.4) flag('bad', `${offHas} of ${offChecked} popular products the worker could NOT find are in Open Food Facts. The worker is probably being blocked or timing out when it asks Open Food Facts. New users would see "Retail Grocery Item" for products that have real data.`);
const aIngr = pct(A.ingr, A.found), bIngr = pct(B.ingr, B.found);
if (B.found >= 20 && bIngr < 60) flag('info', `Only ${bIngr}% of found popular products include an ingredient list. Allergen checks need ingredients, so the app shows "not checked" for the rest.`);
const level = level0();

const lines = [
  `RAKKA first-scan audit: ${level}`, '',
  ...flags.map((f) => `- [${f.level}] ${f.text}`), '',
  `A. Products already in the catalog: ${A.found}/${A.total - A.errs} found (${aPct}%), ingredients on ${aIngr}% of those, median ${median(A.ms)} ms, ${A.errs} errors`,
  `B. Most-scanned US products: ${B.found}/${B.total - B.errs} found (${bPct}%), ingredients on ${bIngr}% of those, median ${median(B.ms)} ms, ${B.errs} request errors ${JSON.stringify(B.errKinds)}`,
  `   Of the ${B.miss.length} popular products NOT found by the worker, Open Food Facts itself has ${offHas} of the ${offChecked} checked.`, '',
];
if (B.miss.length) lines.push('Popular products NOT found (these would show "Retail Grocery Item" to a new user):', ...B.miss.slice(0, 40).map((m) => `  ${m.upc}  ${m.name}${m.offHas ? '   [Open Food Facts HAS this]' : ''}  worker said: ${m.diag || '-'} (${m.ms} ms)`), '');
if (A.miss.length) lines.push('Catalog products NOT found by the worker (should be zero):', ...A.miss.slice(0, 30).map((m) => `  ${m.upc}  ${m.name}`), '');
const txt = lines.join('\n');
fs.writeFileSync('scan_report.txt', txt);
fs.writeFileSync('scan_report.html', `<pre style="font-family:ui-monospace,monospace;font-size:13px">${txt.replace(/[&<]/g, (c) => ({ '&': '&amp;', '<': '&lt;' }[c]))}</pre>`);
fs.writeFileSync('scan_result.json', JSON.stringify({ level, flags, A: { ...A, ms: undefined }, B: { ...B, ms: undefined } }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + txt + '\n```\n');
console.log(txt);
if (level === 'ACTION NEEDED') process.exit(1);
