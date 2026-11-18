// Quick end-to-end check run by GitHub on every push. Loads the app in a real browser and checks the things that broke before.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8130, '127.0.0.1', r));
const base = 'http://127.0.0.1:8130/index.html';
const exe = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await puppeteer.launch({ executablePath: exe, args: ['--no-sandbox'], headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setBypassServiceWorker(true);
await page.setRequestInterception(true);
page.on('request', (r) => (r.url().startsWith('http://127.0.0.1') ? r.continue() : r.abort()));
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('rakka_terms_acceptance', JSON.stringify({ accepted: true, version: '2026-11-13', acceptedAt: new Date().toISOString() }));
  localStorage.setItem('rakka_disclaimer_accepted', 'true');
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const load = async () => { await page.goto(base, { waitUntil: 'domcontentloaded' }); await wait(6000); };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

await load();
check('App loads without script errors', errors.length === 0, errors.slice(0, 2).join(' | '));

// Scan result opens full-screen and closes with X
await page.evaluate(() => {
  setNavTab('barcodes');
  displayResult({ upc: '399069', source: 'manual', productName: 'Test Product', brand: 'Brand', time: 'now', ingredients: 'water', declaredAllergens: [], detectedAllergens: [], traces: [], detectedAdditives: [], familyMatches: [], unverified: false });
});
await wait(300);
const isOpen = () => page.evaluate(() => !!document.getElementById('rkScanDetail')?.classList.contains('rk-wd-open'));
check('Scan result opens full-screen', await isOpen());
await page.evaluate(() => document.querySelector('#rkScanDetail .rk-wd-x').click());
await wait(300);
check('X closes the scan result', !(await isOpen()));

// Watchlist saves and survives a reload
await page.evaluate(() => {
  scanHistory = Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, upc: String(41498123450 + i), productName: 'Item ' + i, brand: 'B', status: 'clear', timestamp: Date.now(), source: 'manual' }));
  saveHistory();
});
await wait(1200);
await load();
const n = await page.evaluate(() => scanHistory.length);
check('Watchlist survives reload', n === 5, `(${n} items)`);
const legacy = await page.evaluate(() => ['rakka_history', 'safebite_history', 'recall_radar_history'].some((k) => localStorage.getItem(k) !== null));
check('Watchlist is not duplicated in localStorage', !legacy);

// Receipt import always ends on the Watchlist
await page.evaluate(() => {
  setNavTab('receipts');
  document.getElementById('receiptAuditLoadingBox').classList.remove('hidden');
  autoImportReceiptDirectlyToWatchlist({ storeName: 'Test', items: [{ cleanName: 'Milk', upc: '041498999990' }, null] });
});
await wait(3500);
const rc = await page.evaluate(() => ({
  loadingHidden: document.getElementById('receiptAuditLoadingBox').classList.contains('hidden'),
  onWatchlist: document.getElementById('tabWatchlist').className.includes('active-tab') && !document.getElementById('tabWatchlist').className.includes('inactive'),
}));
check('Receipt scan clears and opens Watchlist', rc.loadingHidden && rc.onWatchlist);

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
