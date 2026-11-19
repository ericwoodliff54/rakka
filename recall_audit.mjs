// RAKKA weekly recall accuracy audit.
// Loads the SAME matching code the worker uses, pulls the live FDA/USDA feeds, and checks:
//   1. Feed health (are FDA and USDA reachable and fresh?)
//   2. Coverage: every recent recall that prints a barcode must match that barcode exactly.
//   3. Live lookup: the app's own openFDA barcode search must find a sample of those recalls.
//   4. False-positive review: runs the offline product catalog against active recalls and lists what would alert.
// Writes audit_report.html / audit_report.txt / audit_result.json. Never fails the build for findings, only for crashes.
import fs from 'node:fs';
import zlib from 'node:zlib';

const src = fs.readFileSync('rakka-worker.js', 'utf8').replace(/export\s+default\s*\{/, 'const __default = {');
fs.writeFileSync('.worker-under-test.mjs', src + '\nexport { alMakeRecall, alPrepItem, alMatchPrepared, alBuildIndex, alRecallActive, alBarcodeKeys };\n');
const W = await import(process.cwd() + '/.worker-under-test.mjs');
const { alMakeRecall, alPrepItem, alMatchPrepared, alBuildIndex } = W;

const DAYS = 45;
const out = { checks: [], flags: [], stats: {} };
const flag = (level, text) => out.flags.push({ level, text });
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'rakka-audit/1.0' } });
      clearTimeout(t);
      if (r.status === 404) return { __notfound: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

// ---- 1. Feeds
const from = new Date(Date.now() - DAYS * 86400000), to = new Date();
let fdaRows = [], usdaRows = [];
try {
  const key = process.env.OPENFDA_API_KEY ? `&api_key=${process.env.OPENFDA_API_KEY}` : '';
  for (let skip = 0; skip < 3000; skip += 1000) {
    const j = await getJson(`https://api.fda.gov/food/enforcement.json?search=report_date:[${ymd(from)}+TO+${ymd(to)}]&limit=1000&skip=${skip}&sort=report_date:desc${key}`);
    const rows = (j && j.results) || [];
    fdaRows = fdaRows.concat(rows);
    if (rows.length < 1000) break;
  }
  out.checks.push({ name: 'FDA feed reachable', ok: true, detail: `${fdaRows.length} food recall rows in the last ${DAYS} days` });
  if (fdaRows.length < 20) flag('warn', `Only ${fdaRows.length} FDA rows came back for ${DAYS} days. That is lower than normal; check whether openFDA is lagging.`);
} catch (e) { out.checks.push({ name: 'FDA feed reachable', ok: false, detail: String(e.message || e) }); flag('bad', 'The FDA feed could not be reached from GitHub: ' + (e.message || e)); }
try {
  const j = await getJson('https://www.fsis.usda.gov/fsis/api/recall/v/1');
  usdaRows = Array.isArray(j) ? j : [];
  out.checks.push({ name: 'USDA FSIS feed reachable', ok: usdaRows.length > 0, detail: `${usdaRows.length} notices` });
  if (!usdaRows.length) flag('bad', 'The USDA FSIS feed returned no notices.');
} catch (e) { out.checks.push({ name: 'USDA FSIS feed reachable', ok: false, detail: String(e.message || e) }); flag('bad', 'The USDA FSIS feed could not be reached from GitHub: ' + (e.message || e)); }

// Freshness
const fdaDates = fdaRows.map((r) => r.report_date).filter(Boolean).sort();
const newestFda = fdaDates[fdaDates.length - 1];
if (newestFda) {
  const age = (Date.now() - Date.UTC(+newestFda.slice(0, 4), +newestFda.slice(4, 6) - 1, +newestFda.slice(6, 8))) / 86400000;
  out.stats.newestFdaReport = newestFda; out.stats.newestFdaAgeDays = Math.round(age);
  if (age > 21) flag('warn', `The newest FDA enforcement report is ${Math.round(age)} days old (${newestFda}). openFDA may be stale.`);
}

// Worker health
try {
  const h = await getJson('https://rakka-edge.ericwoodliff.workers.dev/health');
  out.checks.push({ name: 'Worker online', ok: h.status === 'online', detail: `build ${h.build}` });
  if (h.status !== 'online') flag('bad', 'The RAKKA worker did not report "online".');
} catch (e) { out.checks.push({ name: 'Worker online', ok: false, detail: String(e.message || e) }); flag('bad', 'The RAKKA worker /health check failed: ' + (e.message || e)); }

// ---- Build the same records the worker builds
const records = [];
for (const r of fdaRows) {
  const d = r.recall_initiation_date || '';
  records.push({ id: r.recall_number, product: r.product_description, firm: r.recalling_firm, reason: r.reason_for_recall, classification: r.classification, status: r.status, agency: 'FDA',
    date: d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6, 8)}/${d.slice(0, 4)}` : '', codesText: String(r.code_info || '').slice(0, 1500) });
}
for (const u of usdaRows.slice(0, 60)) {
  const when = Date.parse(u.field_recall_date || '');
  if (!isNaN(when) && Date.now() - when > 120 * 86400000) continue;
  const summary = String(u.field_summary || u.field_reason || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  records.push({ id: u.field_recall_number || `USDA-${String(u.field_title || '').slice(0, 24)}`, product: `${u.field_title || 'USDA notice'} ${summary}`.slice(0, 600), firm: u.field_establishment || '',
    reason: summary, classification: u.field_risk_level || 'USDA FSIS', status: u.field_closed_date ? 'Closed' : 'Ongoing', agency: 'USDA FSIS', date: u.field_recall_date || '', codesText: '' });
}
const recs = records.map(alMakeRecall);
const active = recs.filter((r) => W.alRecallActive(r));
out.stats.recallsInWindow = recs.length; out.stats.activeRecalls = active.length;

// ---- 2. Coverage: recalls that print a barcode must match it
const withCodes = recs.filter((r) => r.gtins.size > 0 && r.agency === 'FDA');
const serious = recs.filter((r) => r.agency === 'FDA' && /^class (i|ii)\b/i.test(r.classification));
const seriousWithCodes = serious.filter((r) => r.gtins.size > 0);
out.stats.fdaWithBarcode = withCodes.length; out.stats.fdaTotal = recs.filter((r) => r.agency === 'FDA').length;
out.stats.barcodeCoveragePct = out.stats.fdaTotal ? Math.round(100 * withCodes.length / out.stats.fdaTotal) : 0;
const selfFail = [];
for (const r of withCodes) {
  const g = [...r.gtins][0];
  const item = alPrepItem({ u: g.replace(/^0+/, '').padStart(12, '0'), n: r.product.slice(0, 80), b: '' });
  const m = alMatchPrepared(item, r);
  if (!m || m.confidence !== 'exact') selfFail.push({ id: r.id, gtin: g, got: m ? m.confidence : 'none', product: r.product.slice(0, 90) });
}
out.checks.push({ name: 'Recalls with a barcode match that barcode', ok: selfFail.length === 0, detail: `${withCodes.length - selfFail.length} of ${withCodes.length} exact` });
if (selfFail.length) flag('bad', `${selfFail.length} recall(s) list a barcode that the matcher does NOT match exactly (see table).`);
out.selfFail = selfFail.slice(0, 25);
const noCode = serious.length - seriousWithCodes.length;
out.stats.seriousNoBarcode = noCode;
if (serious.length && noCode / serious.length > 0.7) flag('info', `${noCode} of ${serious.length} Class I/II recalls print no barcode at all. Those can only be matched by brand and product name, so they are the main place a miss could hide.`);

// ---- 3. Live lookup the way the app does it (openFDA search by barcode)
// Only recalls that are still active: the app and worker deliberately ignore terminated or completed ones.
const sample = withCodes.filter((r) => W.alRecallActive(r) && /^class (i|ii)\b/i.test(r.classification)).slice(0, 25);
const liveMiss = [];
let liveChecked = 0;
for (const r of sample) {
  const code = [...r.gtins][0].replace(/^0+/, '');
  const up = code.length === 13 ? code : code.padStart(12, '0');
  try {
    const key = process.env.OPENFDA_API_KEY ? `&api_key=${process.env.OPENFDA_API_KEY}` : '';
    const j = await getJson(`https://api.fda.gov/food/enforcement.json?search=(code_info:%22${up}%22+OR+product_description:%22${up}%22)&limit=5${key}`, 2);
    liveChecked++;
    const hit = j && j.results && j.results.some((x) => x.recall_number === r.id);
    if (!hit) liveMiss.push({ id: r.id, code: up, product: r.product.slice(0, 90) });
  } catch (e) { /* network hiccup: not counted */ }
  await sleep(300);
}
out.checks.push({ name: 'App barcode search finds recent recalls', ok: liveMiss.length === 0, detail: `${liveChecked - liveMiss.length} of ${liveChecked} sampled recalls found by the same openFDA query the app runs` });
if (liveMiss.length) flag('info', `${liveMiss.length} sampled recall(s) were not returned by the plain openFDA barcode search (the app now asks the worker first, which reads spaced barcodes).`);
out.liveMiss = liveMiss;

// ---- 3b. The same barcodes through the worker's /recall-check endpoint (what the app now asks first)
const wkMiss = [];
let wkChecked = 0, wkMissing = false;
for (const r of sample) {
  const code = [...r.gtins][0].replace(/^0+/, '');
  const up = code.length === 13 ? code : code.padStart(12, '0');
  try {
    const j = await getJson(`https://rakka-edge.ericwoodliff.workers.dev/recall-check?upc=${up}`, 2);
    if (j && j.__notfound) { wkMissing = true; break; }
    wkChecked++;
    const hit = j && Array.isArray(j.matches) && j.matches.some((m) => m.confidence === 'exact' && m.id === r.id);
    if (!hit) wkMiss.push({ id: r.id, code: up, product: r.product.slice(0, 90) });
  } catch (e) { /* hiccup */ }
  await sleep(150);
}
if (wkMissing) { out.checks.push({ name: 'Worker /recall-check finds recent recalls', ok: false, detail: 'endpoint not deployed yet' }); flag('warn', 'The worker has no /recall-check endpoint yet (stage 65 not deployed).'); }
else {
  out.checks.push({ name: 'Worker /recall-check finds recent recalls', ok: wkMiss.length === 0, detail: `${wkChecked - wkMiss.length} of ${wkChecked} sampled recalls found` });
  if (wkMiss.length) flag('bad', `${wkMiss.length} sampled recall(s) were NOT found by the worker's /recall-check (see table). The feed may be missing them (the feed holds ongoing recalls from the last 12 months).`);
}
out.wkMiss = wkMiss;

// ---- 4. False-positive review against the catalog
let items = [];
try {
  const cat = JSON.parse(zlib.gunzipSync(fs.readFileSync('community_catalog.json.gz')));
  items = (cat.items || []).map((x) => ({ u: x.upc, n: x.name, b: x.brand }));
} catch (e) { flag('warn', 'Could not read community_catalog.json.gz for the false-positive review: ' + e.message); }
const index = alBuildIndex(recs);
const hits = { exact: [], near: [], possible: [], related: [] };
for (const it of items) {
  const pi = alPrepItem(it);
  const cands = new Set();
  for (const g of pi.keys.gtins) (index.byGtin.get(g) || []).forEach((r) => cands.add(r));
  for (const st of pi.keys.stems) (index.byStem.get(st) || []).forEach((r) => cands.add(r));
  for (const e of pi.est) (index.byEst.get(e) || []).forEach((r) => cands.add(r));
  for (const z of pi.keys.pfx) (index.byPfx.get(z.slice(0, 11)) || []).forEach((r) => cands.add(r));
  for (const t of pi.nameTokens) for (const w of [t, t + 's', t + 'es']) (index.byWord.get(w) || []).forEach((r) => cands.add(r));
  for (const r of cands) {
    const m = alMatchPrepared(pi, r);
    if (m) hits[m.confidence].push({ item: `${it.b ? it.b + ' ' : ''}${it.n || ''}`.slice(0, 100), upc: it.u, recall: r.id, agency: r.agency, recallProduct: r.product.slice(0, 110), firm: r.firm.slice(0, 50), why: m.why });
  }
}
out.stats.catalogItems = items.length;
out.stats.hits = { exact: hits.exact.length, near: hits.near.length, possible: hits.possible.length, related: hits.related.length };
out.review = { exact: hits.exact.slice(0, 30), near: hits.near.slice(0, 20), possible: hits.possible.slice(0, 40) };
if (hits.possible.length + hits.near.length > 0) flag('info', `${hits.possible.length} name-based and ${hits.near.length} near-barcode catalog matches need a quick human look for false positives (listed below).`);
if (items.length && hits.possible.length > 60) flag('warn', `${hits.possible.length} name-based "possible" matches is unusually many. The name matcher may be too loose this week.`);

// ---- Report
const level = out.flags.some((f) => f.level === 'bad') ? 'ACTION NEEDED' : out.flags.some((f) => f.level === 'warn') ? 'Review' : 'All clear';
out.level = level;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tbl = (rows, cols) => rows.length ? `<table cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr>${cols.map((c) => `<th align="left" style="border-bottom:1px solid #ccc">${esc(c[0])}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td style="border-bottom:1px solid #eee;vertical-align:top">${esc(r[c[1]])}</td>`).join('')}</tr>`).join('')}</table>` : '<p><em>None.</em></p>';
const colour = { bad: '#b91c1c', warn: '#b45309', info: '#0369a1' };
let html = `<div style="font-family:Arial,sans-serif;max-width:760px"><h2>RAKKA recall audit: ${level}</h2><p>${new Date().toUTCString()}</p>`;
html += out.flags.length ? '<h3>Findings</h3><ul>' + out.flags.map((f) => `<li style="color:${colour[f.level]}">${esc(f.text)}</li>`).join('') + '</ul>' : '<p>No findings.</p>';
html += '<h3>Checks</h3><ul>' + out.checks.map((c) => `<li>${c.ok ? 'PASS' : 'FAIL'}: ${esc(c.name)} (${esc(c.detail)})</li>`).join('') + '</ul>';
html += `<h3>Numbers</h3><ul><li>Recalls in the window: ${out.stats.recallsInWindow} (active ${out.stats.activeRecalls})</li><li>FDA recalls that print a barcode: ${out.stats.fdaWithBarcode} of ${out.stats.fdaTotal} (${out.stats.barcodeCoveragePct}%)</li><li>Class I/II recalls with no barcode: ${out.stats.seriousNoBarcode}</li><li>Catalog products checked: ${out.stats.catalogItems}</li><li>Catalog matches: exact ${out.stats.hits.exact}, near ${out.stats.hits.near}, possible ${out.stats.hits.possible}, related ${out.stats.hits.related}</li></ul>`;
html += '<h3>Barcode recalls the matcher did not match exactly</h3>' + tbl(out.selfFail, [['Recall', 'id'], ['Barcode', 'gtin'], ['Result', 'got'], ['Product', 'product']]);
html += '<h3>Recalls the app\'s live barcode query missed</h3>' + tbl(out.liveMiss, [['Recall', 'id'], ['Barcode', 'code'], ['Product', 'product']]);
html += '<h3>Recalls the worker /recall-check missed</h3>' + tbl(out.wkMiss, [['Recall', 'id'], ['Barcode', 'code'], ['Product', 'product']]);
const rv = [['Exact barcode matches in the catalog (real products on recall: confirm)', out.review.exact], ['Near-barcode matches (check)', out.review.near], ['Name-based matches (look for false positives)', out.review.possible]];
for (const [title, rows] of rv) html += `<h3>${title}</h3>` + tbl(rows, [['Catalog product', 'item'], ['Recall', 'recall'], ['Recall says', 'recallProduct'], ['Firm', 'firm']]);
html += '</div>';
fs.writeFileSync('audit_report.html', html);
const txt = `RAKKA recall audit: ${level}\n\n` + out.flags.map((f) => `- [${f.level}] ${f.text}`).join('\n') + '\n\n' + out.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name} (${c.detail})`).join('\n') + '\n\nOpen audit_report.html for the full tables.\n';
fs.writeFileSync('audit_report.txt', txt);
fs.writeFileSync('audit_result.json', JSON.stringify({ level: out.level, flags: out.flags, stats: out.stats }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, txt + '\n' + html + '\n');
console.log(txt);
fs.unlinkSync('.worker-under-test.mjs');
