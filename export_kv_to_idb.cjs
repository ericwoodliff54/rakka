/**
 * export_kv_to_idb.cjs
 *
 * Builds community_catalog.json.gz for Rakka's offline IndexedDB catalog.
 *
 * Mode 1 (Fastest - Local Seed JSONs):
 *   node export_kv_to_idb.cjs
 *   Reads any ./rakka_community_seed_part*.json files in the current folder.
 *
 * Mode 2 (Direct from Cloudflare KV API):
 *   Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, then run:
 *   node export_kv_to_idb.cjs --from-kv
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KV_NAMESPACE_ID = '13e138ca5e594e778782a18c622b2781';
const MAX_ITEMS = 55000;

function normalizeRecord(rawKey, val) {
  const clean = String(rawKey || '').replace(/^upc:/i, '').replace(/\D/g, '');
  if (!clean || clean.length < 8) return null;
  const upc = clean.padStart(12, '0');
  const obj = typeof val === 'string' ? JSON.parse(val) : val;
  if (!obj || (!obj.name && !obj.n) || String(obj.name || obj.n).startsWith('Retail Grocery Item')) {
    return null;
  }
  return {
    upc,
    name: obj.name || obj.n,
    brand: obj.brand || obj.b || 'Grocery Brand',
    ingredients: obj.ingredients || obj.i || '',
    allergens: Array.isArray(obj.allergens || obj.al) ? (obj.allergens || obj.al) : [],
    additives: Array.isArray(obj.additives || obj.ad) ? (obj.additives || obj.ad) : []
  };
}

async function exportFromLocalSeeds() {
  const files = fs.readdirSync('.').filter(f => /^rakka_community_seed_part\d+\.json$/i.test(f)).sort();
  if (files.length === 0) return null;

  console.log(`Found ${files.length} local seed files. Deduplicating...`);
  const map = new Map();
  for (const file of files) {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of entries) {
      const rec = normalizeRecord(entry.key, entry.value);
      if (rec && !map.has(rec.upc)) {
        map.set(rec.upc, rec);
        if (map.size >= MAX_ITEMS) break;
      }
    }
    if (map.size >= MAX_ITEMS) break;
  }
  return Array.from(map.values());
}

async function exportFromCloudflareKV() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables to export from KV.');
  }

  const headers = { Authorization: `Bearer ${apiToken}` };
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

  const keys = [];
  let cursor = '';
  console.log('Listing keys from RAKKA_COMMUNITY_DB...');
  do {
    const url = `${baseUrl}/keys?prefix=upc:&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    for (const k of data.result) keys.push(k.name);
    cursor = data.result_info?.cursor || '';
  } while (cursor && keys.length < MAX_ITEMS * 2);

  console.log(`Listed ${keys.length} keys. Deduplicating by 12-digit UPC...`);
  const uniqueKeys = new Map();
  for (const k of keys) {
    const upc12 = k.replace(/^upc:/i, '').replace(/\D/g, '').padStart(12, '0');
    if (upc12.length >= 8 && !uniqueKeys.has(upc12)) {
      uniqueKeys.set(upc12, k);
      if (uniqueKeys.size >= MAX_ITEMS) break;
    }
  }

  const keyList = Array.from(uniqueKeys.values());
  const records = [];
  const CONCURRENCY = 25;
  for (let i = 0; i < keyList.length; i += CONCURRENCY) {
    const batch = keyList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async k => {
      const r = await fetch(`${baseUrl}/values/${encodeURIComponent(k)}`, { headers });
      if (!r.ok) return null;
      return normalizeRecord(k, await r.text());
    }));
    for (const rec of results) if (rec) records.push(rec);
    if ((i / CONCURRENCY) % 20 === 0) {
      console.log(`Fetched ${Math.min(i + CONCURRENCY, keyList.length)} / ${keyList.length} products...`);
    }
  }
  return records;
}

(async () => {
  const forceKv = process.argv.includes('--from-kv');
  let records = forceKv ? null : await exportFromLocalSeeds();
  if (!records) {
    records = await exportFromCloudflareKV();
  }
  const payload = JSON.stringify({ version: 'v1', count: records.length, items: records });
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
  fs.writeFileSync(path.join('.', 'community_catalog.json.gz'), gz);
  console.log(`Done! Wrote community_catalog.json.gz (${records.length} items, ${(gz.length / 1024 / 1024).toFixed(2)} MB).`);
})();
