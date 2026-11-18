// End-to-end encryption for household sync.
//
// The household's allergen profiles and Watchlist are encrypted on the phone before they are uploaded, using a random
// 128-bit key that is generated on the host's phone and shared with the partner inside the invite
// (never sent to the server). The server only ever stores an opaque encrypted blob.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY_RE = /^[A-Z2-7]{26}$/;
const CODE_RE = /^RKA-[A-Z0-9]{3}-[A-Z0-9]{3}$/;

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str) {
    const i = B32.indexOf(ch); if (i < 0) return null;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function newKey() {
  const raw = new Uint8Array(16);
  globalThis.crypto.getRandomValues(raw);
  return base32Encode(raw).slice(0, 26);
}

export function isValidKey(key) { return typeof key === 'string' && KEY_RE.test(key); }

// Invite = "RKA-ABC-DEF.<26 char key>". Only the part before the dot is ever sent to the server.
export function formatInvite(code, key) { return `${code}.${key}`; }

export function parseInvite(text) {
  const s = String(text || '').trim().toUpperCase().replace(/\s+/g, '');
  const [code, key, ...rest] = s.split('.');
  if (rest.length || !CODE_RE.test(code || '')) return null;
  if (!isValidKey(key)) return { code, key: null };
  return { code, key };
}

async function importKey(key) {
  const raw = base32Decode(key);
  if (!raw || raw.length < 16) throw new Error('bad key');
  return globalThis.crypto.subtle.importKey('raw', raw.slice(0, 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toB64Url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(str) {
  const p = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Profile fields that are synced.
export function cleanProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter(p => p && p.id).slice(0, 8).map(p => ({
    ...p,
    id: String(p.id),
    name: String(p.name || '').slice(0, 40),
    allergens: Array.isArray(p.allergens) ? [...new Set(p.allergens.map(String))] : []
  }));
}

export async function encryptProfiles(profiles, key) {
  const k = await importKey(key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ v: 1, profiles: cleanProfiles(profiles) }));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return toB64Url(out);
}

// Returns an array of profiles, or null if the blob is empty, damaged, or the key is wrong.
export async function decryptProfiles(blob, key) {
  if (!blob) return null;
  try {
    const k = await importKey(key);
    const all = fromB64Url(blob);
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, k, all.slice(12));
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    return parsed && parsed.v === 1 ? cleanProfiles(parsed.profiles) : null;
  } catch (_) { return null; }
}

// ---- Watchlist sync (also end-to-end encrypted) ----
const WATCHLIST_MAX = 500;
const TOMB_MAX_AGE_MS = 60 * 86400000;

export function itemKey(i) {
  if (!i) return '';
  return String(i.id || i.upc || `${i.productName || i.product || ''}|${i.brand || ''}`).toLowerCase();
}
const itemTime = (i) => Number(i && (i.timestamp || i.scannedDate || i.receiptTimestamp) || 0);

// Keeps the saved fields but drops images and trims very long text so the encrypted blob stays small.
export function cleanWatchlist(items) {
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || typeof it !== 'object' || !itemKey(it)) continue;
    const c = {};
    for (const [k, v] of Object.entries(it)) {
      if (typeof v === 'function' || k === 'familyMatches') continue;
      if (typeof v === 'string') { if (v.startsWith('data:')) continue; c[k] = v.slice(0, 3000); }
      else c[k] = v;
    }
    out.push(c);
  }
  return out.sort((a, b) => itemTime(b) - itemTime(a)).slice(0, WATCHLIST_MAX);
}

export function cleanTombs(tombs, now = Date.now()) {
  const out = {};
  for (const [k, t] of Object.entries(tombs && typeof tombs === 'object' ? tombs : {})) {
    const n = Number(t);
    if (k && n > 0 && now - n < TOMB_MAX_AGE_MS) out[k] = n;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 500));
}

// Union of both lists. Same item: the newer one wins. A removal (tombstone) beats an item that is not newer than it.
export function mergeWatchlist(localItems, remoteItems, localTombs = {}, remoteTombs = {}, now = Date.now()) {
  const tombs = cleanTombs({ ...localTombs }, now);
  for (const [k, t] of Object.entries(cleanTombs(remoteTombs, now))) tombs[k] = Math.max(tombs[k] || 0, t);
  const map = new Map();
  for (const it of [...cleanWatchlist(localItems), ...cleanWatchlist(remoteItems)]) {
    const k = itemKey(it);
    const prev = map.get(k);
    if (!prev || itemTime(it) > itemTime(prev)) map.set(k, it);
  }
  const items = [];
  for (const [k, it] of map) {
    if (tombs[k] && tombs[k] >= itemTime(it)) continue; // removed on one phone
    if (tombs[k]) delete tombs[k];                     // re-added after the removal
    items.push(it);
  }
  items.sort((a, b) => itemTime(b) - itemTime(a));
  return { items: items.slice(0, WATCHLIST_MAX), tombs };
}

async function pipeBytes(bytes, stream) {
  const w = stream.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

// Profiles + watchlist + removals in one encrypted blob (compressed when the browser supports it).
export async function encryptHousehold({ profiles, watchlist, tombs }, key) {
  const k = await importKey(key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const payload = { v: 2, profiles: cleanProfiles(profiles) };
  if (Array.isArray(watchlist)) { payload.watchlist = cleanWatchlist(watchlist); payload.tombs = cleanTombs(tombs); }
  let data = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream !== 'undefined') { try { data = await pipeBytes(data, new CompressionStream('gzip')); } catch (_) {} }
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return toB64Url(out);
}

// Returns { profiles, watchlist (null if the sender did not include one), tombs } or null.
export async function decryptHousehold(blob, key) {
  if (!blob) return null;
  try {
    const k = await importKey(key);
    const all = fromB64Url(blob);
    let pt = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, k, all.slice(12)));
    if (pt[0] === 0x1f && pt[1] === 0x8b) pt = await pipeBytes(pt, new DecompressionStream('gzip'));
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    if (!parsed || (parsed.v !== 1 && parsed.v !== 2)) return null;
    return {
      profiles: cleanProfiles(parsed.profiles),
      watchlist: Array.isArray(parsed.watchlist) ? cleanWatchlist(parsed.watchlist) : null,
      tombs: cleanTombs(parsed.tombs),
    };
  } catch (_) { return null; }
}

// Same-id profiles are merged; allergens are unioned, because dropping an allergen is the unsafe direction.
export function mergeProfiles(a, b) {
  const map = new Map();
  [...cleanProfiles(a), ...cleanProfiles(b)].forEach(p => {
    const prev = map.get(p.id);
    map.set(p.id, prev ? { ...prev, ...p, allergens: [...new Set([...prev.allergens, ...p.allergens])] } : p);
  });
  return [...map.values()].slice(0, 8);
}
