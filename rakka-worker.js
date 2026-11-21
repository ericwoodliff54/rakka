/**
 * RAKKA Cloud Edge Hook - Serverless Barcode Aggregator & Community Cache
 * Designed for Cloudflare Workers (100,000 free requests/day)
 * 100% Private: Zero PII, Zero User Accounts, Zero Tracking
 */

// Master Embedded Key (Optional: Paste Gemini API key here in Cloudflare Quick Edit to bypass dashboard variables)
// Gemini key comes ONLY from Cloudflare secrets (Settings > Variables and Secrets).
// Never paste a key into this file: the repo is public. Client-supplied keys are not accepted.
function resolveGeminiApiKey(env /*, body (ignored) */) {
  const aliases = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY'];
  if (env && typeof env === 'object') {
    for (const alias of aliases) {
      if (typeof env[alias] === 'string' && env[alias].trim().length > 0) {
        return { key: env[alias].trim().replace(/^["\']|["\']$/g, ''), source: `cloudflare_env (${alias})` };
      }
    }
  }
  return { key: '', source: 'none' };
}

// Origins allowed to call this API from a browser. Add more with the ALLOWED_ORIGINS
// variable (comma-separated) instead of editing code.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ericwoodliff54.github.io',
  'https://twinravensdigital.com',
  'https://privacy.twinravensdigital.com',
  'http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5500',
  // App-store wrapper (Capacitor/Ionic) origins: iOS uses capacitor://localhost, Android uses https://localhost
  'capacitor://localhost', 'ionic://localhost', 'https://localhost', 'http://localhost'
];
function getAllowedOrigins(env, request) {
  const extra = (env && env.ALLOWED_ORIGINS) ? String(env.ALLOWED_ORIGINS).split(',').map(x => x.trim()).filter(Boolean) : [];
  let self = [];
  try { self = [new URL(request.url).origin]; } catch (e) {}
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra, ...self];
}
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const HH_TTL_SECONDS = 60 * 60 * 24 * 90; // household records expire after 90 days without a sync

// ============================================================================
// EDGE PER-IP SLIDING WINDOW RATE LIMITER (Zero-KV Cost Isolate Memory Protection)
// Protects Gemini 1.5 Flash OCR endpoints from automated scraping & quota exhaustion
// ============================================================================
const IP_RATE_BUCKETS = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_CONFIG = {
  'audit-receipt': 18,   // 18 req/min per IP (supports up to 6 full 3-slice tall receipts/min)
  'audit-lot-code': 12,  // 12 req/min per IP for package stamp verification
  'detect-package': 12,  // 12 req/min per IP for whole-package vision
  'contribute-ocr': 10,  // 10 req/min per IP for community ingredient OCR
  'household': 30,       // 30 req/min per IP for 2-person household sync
  'household-join': 8,   // brute-force guard for invite codes
  'plus': 10,            // Plus code redemption / status checks
  'alerts': 40,          // background alert sync, queue reads and data deletion
  'pinned': 30,          // public pinned-recall list (small and cacheable)
  'recall-check': 60,    // barcode scans checked against the live recall feed
  'contribute': 10       // community catalog submissions
};


function expandUpcEToUpcAWorker(rawUpcE) {
  const digits = String(rawUpcE || '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const ns = digits[0];
  if (ns !== '0' && ns !== '1') return null;
  const d1 = digits[1], d2 = digits[2], d3 = digits[3], d4 = digits[4], d5 = digits[5], d6 = digits[6], check = digits[7];
  let mfg = '', item = '';
  if (d6 === '0' || d6 === '1' || d6 === '2') {
    mfg = d1 + d2 + d6 + '00';
    item = '00' + d3 + d4 + d5;
  } else if (d6 === '3') {
    mfg = d1 + d2 + d3 + '00';
    item = '000' + d4 + d5;
  } else if (d6 === '4') {
    mfg = d1 + d2 + d3 + d4 + '0';
    item = '0000' + d5;
  } else {
    mfg = d1 + d2 + d3 + d4 + d5;
    item = '0000' + d6;
  }
  return ns + mfg + item + check;
}

function getNormalizedBarcodeVariants(cleanUpc) {
  const codes = new Set([cleanUpc]);
  const stripped = cleanUpc.replace(/^0+/, '');
  if (stripped.length >= 6) codes.add(stripped);
  if (cleanUpc.length === 8) {
    const expanded = expandUpcEToUpcAWorker(cleanUpc);
    if (expanded) {
      codes.add(expanded);
      codes.add('0' + expanded);
    }
  }
  if (cleanUpc.length <= 12) {
    const p12 = cleanUpc.padStart(12, '0');
    const p13 = cleanUpc.padStart(13, '0');
    codes.add(p12);
    codes.add(p13);
  }
  if (cleanUpc.length === 13 && cleanUpc.startsWith('0')) {
    codes.add(cleanUpc.substring(1));
  }
  if (cleanUpc.length === 14 && cleanUpc.startsWith('00')) {
    codes.add(cleanUpc.substring(2));
    codes.add(cleanUpc.substring(1));
  }
  return [...codes];
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'edge-anon-client'
  );
}

// Cloudflare-side backstop for the AI endpoints. Counters live at the edge (shared by every isolate in a location),
// so they hold up under load, unlike the in-memory counters above. Missing bindings are simply skipped.
async function aiGuard(env, request, corsHeaders) {
  try {
    const ip = getClientIp(request) || 'unknown';
    const checks = [];
    if (env && env.RL_AI_IP) checks.push(env.RL_AI_IP.limit({ key: ip }));
    if (env && env.RL_AI_ALL) checks.push(env.RL_AI_ALL.limit({ key: 'ai' }));
    const res = await Promise.all(checks);
    if (res.some(r => r && r.success === false)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'RAKKA is busy right now. Please try again in a minute.',
        retryAfterSeconds: 60
      }), { status: 429, headers: { ...corsHeaders, 'Retry-After': '60', 'Cache-Control': 'no-store' } });
    }
  } catch (_) { /* never block users because the limiter itself had a problem */ }
  return null;
}

function checkEdgeRateLimit(request, endpointBucket) {
  const maxRequests = RATE_LIMIT_CONFIG[endpointBucket] || 15;
  const clientIp = getClientIp(request);
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const key = `${endpointBucket}:${clientIp}`;

  // Periodic lightweight cleanup to prevent unbounded Map growth in long-lived isolates
  if (IP_RATE_BUCKETS.size > 2000) {
    for (const [k, timestamps] of IP_RATE_BUCKETS.entries()) {
      const valid = timestamps.filter(ts => ts > windowStart);
      if (valid.length === 0) IP_RATE_BUCKETS.delete(k);
      else IP_RATE_BUCKETS.set(k, valid);
    }
  }

  const prevTimestamps = IP_RATE_BUCKETS.get(key) || [];
  const recentTimestamps = prevTimestamps.filter(ts => ts > windowStart);

  if (recentTimestamps.length >= maxRequests) {
    const oldestInWindow = recentTimestamps[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      retryAfterSec,
      headers: {
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS) / 1000)),
        'Retry-After': String(retryAfterSec)
      }
    };
  }

  recentTimestamps.push(now);
  IP_RATE_BUCKETS.set(key, recentTimestamps);
  const remaining = Math.max(0, maxRequests - recentTimestamps.length);

  return {
    allowed: true,
    limit: maxRequests,
    remaining,
    retryAfterSec: 0,
    headers: {
      'X-RateLimit-Limit': String(maxRequests),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000))
    }
  };
}


const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy | Twin Ravens Digital LLC</title>
  <meta name="description" content="Privacy Policy and Terms for RAKKA Food Safety &amp; Recall Scanner by Twin Ravens Digital LLC. No accounts. Your data stays on your device unless you turn on an optional feature, and you can delete it all in the app.">
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    :root {
      --bg: #020617;
      --card-bg: #0f172a;
      --border: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #06b6d4;
      --accent-grad: linear-gradient(135deg, #0891b2, #14b8a6);
      --gold: #f59e0b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #cbd5e1;
        --text: #0f172a;
        --text-muted: #475569;
        --accent: #0284c7;
        --accent-grad: linear-gradient(135deg, #0284c7, #0d9488);
        --gold: #d97706;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.65;
      padding: 1.5rem 1rem 4rem;
    }
    .container {
      max-width: 768px;
      margin: 0 auto;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      background: rgba(6, 182, 212, 0.12);
      color: var(--accent);
      border: 1px solid rgba(6, 182, 212, 0.3);
      width: fit-content;
    }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      color: var(--text);
    }
    .subtitle {
      font-size: 0.95rem;
      color: var(--text-muted);
    }
    .policy-meta {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    .summary-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 1rem;
      padding: 1.25rem 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    }
    .summary-card h2 {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--text);
    }
    .summary-card p {
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    h2 {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    p {
      font-size: 0.925rem;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }
    p:last-child { margin-bottom: 0; }
    strong { color: var(--text); }
    ul {
      list-style-type: none;
      padding-left: 0;
      margin: 0.75rem 0;
    }
    li {
      position: relative;
      padding-left: 1.5rem;
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }
    li::before {
      content: "•";
      position: absolute;
      left: 0.5rem;
      color: var(--accent);
      font-weight: bold;
    }
    .contact-box {
      background: rgba(6, 182, 212, 0.06);
      border: 1px solid rgba(6, 182, 212, 0.2);
      border-radius: 0.75rem;
      padding: 1rem;
      margin-top: 0.75rem;
      font-size: 0.875rem;
    }
    footer {
      text-align: center;
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 3rem;
      border-top: 1px solid var(--border);
      padding-top: 1.5rem;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.85rem; }
    th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); color: var(--text-muted); }
    th { color: var(--text); font-weight: 700; }
    td:first-child { color: var(--text); font-weight: 600; white-space: nowrap; }
    @media (max-width: 560px) { td:first-child { white-space: normal; } table { font-size: 0.8rem; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">Official Legal Notice</div>
      <h1>Privacy Policy & Terms</h1>
      <p class="subtitle">Twin Ravens Digital LLC • RAKKA Food Safety & Recall Scanner</p>
      <p class="policy-meta">Effective Date: November 17, 2026 • Version 1.6</p>
    </header>

    <div class="summary-card">
      <h2>In short</h2>
      <p>RAKKA needs no account. Your scans, receipts, allergen guards and family profiles are stored on your device. They leave it only when you turn on a feature that needs the server, and section 3 lists exactly what is sent for each one. You can erase everything, on your device and on our server, with <strong>Delete my data</strong> in Settings.</p>
    </div>

    <section>
      <h2>1. What we do not collect</h2>
      <ul>
        <li><strong>No account.</strong> No email, phone number, password or social login is needed to use RAKKA.</li>
        <li><strong>No location tracking.</strong> We do not collect your GPS position or your shopping routes.</li>
        <li><strong>No advertising or data sales.</strong> We do not sell, rent or share your dietary information, household profiles, watchlist or scan history with data brokers, insurers, food makers or advertisers. RAKKA has no ad or analytics trackers.</li>
      </ul>
    </section>

    <section>
      <h2>2. What stays on your device</h2>
      <p>RAKKA works offline first. These are saved in your device's browser storage and are not sent to us unless you turn on a feature in section 3:</p>
      <ul>
        <li><strong>Allergen guards and family profiles:</strong> names, avatars and allergen choices.</li>
        <li><strong>Watchlist and scan history:</strong> the products you scanned or imported from receipts.</li>
        <li><strong>Settings:</strong> theme, sound, haptics and filters.</li>
        <li><strong>Offline product database:</strong> a copy of public product information (names, brands and ingredient text), about 30 MB, so scans are fast and work without a signal. It holds nothing about you. You can turn it off and remove it in Settings, Privacy and data.</li>
      </ul>
      <p>The camera is used only to read barcodes. Video is processed in memory on your device and is never recorded or uploaded.</p>
    </section>

    <section>
      <h2>3. What is sent to our server, and when</h2>
      <p>Our server is a Cloudflare Worker with Cloudflare storage. The table lists everything it keeps about you or your device.</p>
      <table>
        <thead><tr><th>Feature</th><th>What is sent and kept</th><th>How long</th></tr></thead>
        <tbody>
          <tr><td>Background recall alerts (Plus, optional)</td><td>The names, brands and barcodes of items on your watchlist, with a random device ID, a random alert key, your Plus token and, in the store app, a push notification token. Never your allergen profiles, family profiles, household, name or email.</td><td>Until you turn alerts off, your Plus access ends, or you use Delete my data. Refreshed each time the app opens; erased after 120 days without one.</td></tr>
          <tr><td>Household sync (Plus, optional)</td><td>Your family profiles and your watchlist (product names, brands and barcodes), encrypted on your device with a key that is shared only in your invite code or QR. We cannot read them. Receipts, photos and settings are never synced.</td><td>Up to 90 days after the last sync, or until the last member leaves.</td></tr>
          <tr><td>Receipt scanning</td><td>The receipt photo is sent over HTTPS to our Worker, which passes it to Google's Gemini service to read the items. We do not store the image or link it to you. Google handles the image under its own terms for the Gemini API.</td><td>Not stored by us.</td></tr>
          <tr><td>Scan limits</td><td>A random device ID with a count of receipt scans, and a one-way hash of your network address as a backstop against abuse. No names or products.</td><td>Up to 35 days.</td></tr>
          <tr><td>Plus trial and invite codes</td><td>A random device ID with the trial start time or the invite code it used, so a trial or code can only be used as intended.</td><td>The trial marker is kept so a trial cannot be repeated. It holds no personal data. A code seat is freed by Delete my data.</td></tr>
          <tr><td>Product catalog</td><td>When a barcode is looked up, public packaging facts (product name, brand, ingredient text) may be cached for everyone. Each product also carries the date it was last looked up, which decides what is included in the offline database. This holds nothing about you or your device.</td><td>Until replaced.</td></tr>
        </tbody>
      </table>
      <p><strong>Recall alert notifications</strong> contain only a generic message such as "A recall may affect an item on your watchlist". The product name never passes through Apple's or Google's push services. The details are shown inside RAKKA when you open it.</p>
      <p><strong>What this means for privacy:</strong> background alerts need the server to read the product names and barcodes you send, so they are not end-to-end encrypted. We use them only to check recalls for you. Household sync is end-to-end encrypted. If you prefer, leave background alerts off; RAKKA still checks your watchlist against recalls each time you open it.</p>
    </section>

    <section>
      <h2>4. Your choices and deleting your data</h2>
      <ul>
        <li><strong>Turn alerts off:</strong> Settings, Background Recall Alerts. Your watchlist copy is erased from the server.</li>
        <li><strong>Delete my data:</strong> Settings, Delete my data. This erases your scans, receipts, profiles, settings and offline product database from your device, removes your background alert data from our server, leaves your household, and frees any invite code seat. If the server cannot be reached, nothing is deleted and you are told so, so you can try again.</li>
        <li><strong>Questions or requests:</strong> contact us at the address in section 8. Because RAKKA has no accounts, we identify your data by the random device ID in the app, so we can only act on requests made from the app itself.</li>
      </ul>
    </section>

    <section>
      <h2>5. Third-party services</h2>
      <ul>
        <li><strong>Federal recall data:</strong> recalls come from the public openFDA and USDA Food Safety and Inspection Service (FSIS) feeds. The app requests them directly, and our server requests them to check alerts.</li>
        <li><strong>Google Gemini:</strong> reads receipt photos, as described above.</li>
        <li><strong>Cloudflare:</strong> hosts our server and storage.</li>
        <li><strong>Apple and Google push services:</strong> deliver the generic alert in the store app.</li>
        <li><strong>Subscriptions:</strong> while RAKKA is in testing, Plus is available by invite code or a one-time 7-day trial. When paid plans start in the Apple App Store and Google Play, payment is handled by Apple or Google and we do not receive your payment details.</li>
      </ul>
    </section>

    <section>
      <h2>6. Terms of use</h2>
      <ul>
        <li><strong>Information, not a guarantee.</strong> RAKKA is an informational tool that helps you check foods against public recall notices and the allergens you select. It is not a medical device. It never tells you a food is "safe". Recall data can be incomplete or delayed, and a possible match may not be your exact product. Always read the package, check lot codes and best-by dates, and follow the instructions in the recall notice. If you have a severe allergy, do not rely on RAKKA alone.</li>
        <li><strong>Use.</strong> Use RAKKA for your own household's personal use and do not misuse the service, attempt to bypass limits, or probe the server.</li>
        <li><strong>Plus.</strong> Plus features, limits and prices may change. Invite codes and trials may be withdrawn.</li>
        <li><strong>No warranty.</strong> RAKKA is provided as is. To the extent the law allows, Twin Ravens Digital LLC is not liable for losses resulting from its use.</li>
        <li><strong>Changes.</strong> We may update this page. The effective date at the top shows the latest version, and the app asks you to accept material changes.</li>
      </ul>
    </section>

    <section>
      <h2>7. Children</h2>
      <p>RAKKA is not directed to children under 13 and does not knowingly collect personal information from them. Family profiles are created and managed by a parent or guardian on their own device.</p>
    </section>

    <section>
      <h2>8. Contact</h2>
      <p>For questions, privacy requests or legal communications about RAKKA or Twin Ravens Digital LLC:</p>
      <div class="contact-box">
        <strong>Twin Ravens Digital LLC</strong><br>
        Registered Agent Address: 6545 Market Ave. North, Ste 100, Canton, OH 44721<br>
        Principal Operations: Stow, Ohio, United States<br>
        Official Email: <a href="mailto:contact@twinravensdigital.com">contact@twinravensdigital.com</a><br>
        Website: <a href="https://twinravensdigital.com" target="_blank" rel="noopener">twinravensdigital.com</a>
      </div>
    </section>

    <footer>
      <p>&copy; 2026 Twin Ravens Digital LLC. All rights reserved.</p>
      <p>RAKKA Scanner is a trademark of Twin Ravens Digital LLC.</p>
    </footer>
  </div>
</body>
</html>
`;

// ============================================================================
// RAKKA PLUS: server-verified entitlement
// Plus is granted by invite codes (secret PLUS_CODES = "CODE:maxDevices,CODE2:maxDevices") or a one-time
// 7-day trial per device. The worker signs a token (secret PLUS_SIGNING_SECRET) that the app keeps and
// re-checks with /plus/status. Removing a code from PLUS_CODES revokes it on the next check.
// ============================================================================
const PLUS_TOKEN_DAYS = 30;
const PLUS_TRIAL_DAYS = 7;
const plusEnc = new TextEncoder();
const plusB64u = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const plusFromB64u = (str) => { const p = String(str).replace(/-/g, '+').replace(/_/g, '/'); const s = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

async function plusHmacKey(env) {
  const secret = env && env.PLUS_SIGNING_SECRET;
  if (!secret || String(secret).length < 16) return null;
  return crypto.subtle.importKey('raw', plusEnc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signPlusToken(env, payload) {
  const key = await plusHmacKey(env);
  if (!key) return null;
  const body = plusB64u(plusEnc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, plusEnc.encode(body)));
  return `${body}.${plusB64u(sig)}`;
}

function parsePlusCodes(env) {
  const map = new Map();
  String((env && env.PLUS_CODES) || '').split(',').forEach(part => {
    const [rawCode, rawMax] = part.split(':');
    const code = String(rawCode || '').trim().toUpperCase();
    if (code.length >= 6) map.set(code, Math.max(1, Math.min(20, parseInt(rawMax, 10) || 1)));
  });
  return map;
}

// Returns the token payload if the token is genuine, unexpired, for this device, and (for codes) not revoked.
async function checkPlus(env, token, deviceId) {
  try {
    if (!token || !deviceId || typeof token !== 'string' || token.length > 600) return null;
    const key = await plusHmacKey(env);
    if (!key) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', key, plusFromB64u(sig), plusEnc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(plusFromB64u(body)));
    if (!p || p.d !== String(deviceId) || !(p.exp > Date.now())) return null;
    if (p.k === 'code') {
      if (!parsePlusCodes(env).has(String(p.c))) return null;
      const devs = await env.RAKKA_COMMUNITY_DB.get(`plusdev:${p.c}`, { type: 'json' });
      if (!Array.isArray(devs) || !devs.includes(String(deviceId))) return null;
    } else if (p.k !== 'trial') {
      return null;
    }
    return p;
  } catch (_) { return null; }
}


// ============================================================================
// RECEIPT SCAN QUOTA (server-side, so clearing browser data cannot reset it)
// Free: 5 receipt scans / month per device (+ a generous per-network backstop).
// Plus (invite code or trial): 15 receipt scans / day per device.
// One receipt photo is sent as up to 3 slices; the app tags them with one scanId so they count once.
// ============================================================================
const FREE_RECEIPT_MONTHLY = 5;
const FREE_RECEIPT_MONTHLY_PER_NETWORK = 150; // phone carriers put many people behind one address, so keep this loose
const PLUS_RECEIPT_DAILY = 15;

async function receiptQuotaSlot(env, key, limit, scanId, ttlSeconds) {
  let ids = [];
  try {
    const cur = await env.RAKKA_COMMUNITY_DB.get(key, { type: 'json' });
    if (Array.isArray(cur)) ids = cur;
  } catch (_) {}
  if (ids.includes(scanId)) return true;
  if (ids.length >= limit) return false;
  ids.push(scanId);
  // The three slices of one receipt arrive together and each try to save the same record. KV allows one write per second
  // per key, so a write can be refused. That must never fail the scan: the slice that won already saved this scan id.
  try { await env.RAKKA_COMMUNITY_DB.put(key, JSON.stringify(ids), { expirationTtl: ttlSeconds }); } catch (_) {}
  return true;
}

async function enforceReceiptQuota(env, request, body) {
  const deviceId = String((body && body.deviceId) || '').trim().slice(0, 80);
  const scanId = String((body && body.scanId) || '').trim().slice(0, 64);
  if (!deviceId || !scanId) {
    return { ok: false, status: 400, error: 'Please refresh RAKKA to get the latest version, then scan again.' };
  }
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const day = now.toISOString().slice(0, 10);
  const plus = await checkPlus(env, body.plusToken, deviceId);
  if (plus) {
    const ok = await receiptQuotaSlot(env, `rq:d:${deviceId}:${day}`, PLUS_RECEIPT_DAILY, scanId, 172800);
    return ok ? { ok: true } : { ok: false, status: 429, quotaExceeded: true, plus: true,
      error: `Daily fair-use limit reached (${PLUS_RECEIPT_DAILY} receipt scans today). It resets at midnight UTC.` };
  }
  const okDevice = await receiptQuotaSlot(env, `rq:m:${deviceId}:${month}`, FREE_RECEIPT_MONTHLY, scanId, 3456000);
  if (!okDevice) {
    return { ok: false, status: 429, quotaExceeded: true, plus: false,
      error: `Monthly free limit reached (${FREE_RECEIPT_MONTHLY}/${FREE_RECEIPT_MONTHLY} receipt scans used). Start your 7-day free Plus trial for up to ${PLUS_RECEIPT_DAILY} scans a day.` };
  }
  // Backstop against a fresh device ID on every scan. Only a hash of the network address is kept.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip) {
    const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', plusEnc.encode('rq|' + ip)));
    const ipKey = Array.from(dig.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
    const okIp = await receiptQuotaSlot(env, `rq:ip:${ipKey}:${month}`, FREE_RECEIPT_MONTHLY_PER_NETWORK, scanId, 3456000);
    if (!okIp) {
      return { ok: false, status: 429, quotaExceeded: true, plus: false,
        error: 'This network has used its free receipt scans for the month. Start your 7-day free Plus trial to keep scanning.' };
    }
  }
  return { ok: true };
}


// ============================================================================
// BACKGROUND RECALL ALERTS (RAKKA Plus)
// While alerts are on, the phone sends the NAMES, BRANDS and BARCODES of its watchlist, plus a random
// device id, a random alert secret and (in the store app) a push token. Nothing else: no allergen
// profiles, family profiles, household, name or email. A scheduled job (Cloudflare Cron Trigger) checks
// new FDA and USDA recalls against those items, queues what matches, and sends a generic push when a
// push token exists. The app also fetches the queue every time it opens, so a missed push is never a
// missed recall. Matches are labelled exact / near / possible; the app tells the person to check lot codes.
// KV record  al:<deviceId> = { v, sec, tk, pt, pf, items:[{n,b,u}], upd, chk, seen:{recallId:ts}, pending:[...] }
// ============================================================================
const AL_PREFIX = 'al:';
const AL_TTL_SECONDS = 120 * 86400;
const AL_MAX_ITEMS = 500;
const AL_MAX_PENDING = 20;
const AL_MAX_SEEN = 400;
const AL_FEED_TTL_MS = 20 * 60 * 1000;
const AL_DEVICES_PER_RUN = 2500;   // per scheduled run (Workers Paid allows 10,000 storage calls per run)
const AL_RUN_BUDGET_MS = 22000;     // stop a run early after this long and resume on the next one
const AL_CONCURRENCY = 25;
const AL_KNOWN_CAP = 3000;

const alNorm = (value) => String(value == null ? '' : value)
  .replace(/[ÂÃâã][\u0080-¿]+/g, ' ')
  .toLowerCase()
  .replace(/[‘’]/g, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\x00-\x7f]/g, ' ')
  .replace(/['`]/g, '')
  .replace(/[-_/]/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')   // commas, periods, colons etc. must not stick to words ("spinach," must equal "spinach")
  .replace(/\s+/g, ' ')
  .trim();
const alDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const alEscRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alHasWord = (wordSet, w) => wordSet.has(w) || wordSet.has(w + 's') || wordSet.has(w + 'es');

function alCheckDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}
const alValidCheck = (code) => code.length >= 2 && alCheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
function alExpandUpcE(c8) {
  if (!/^[01]\d{7}$/.test(c8)) return null;
  const ns = c8[0], chk = c8[7];
  const [d1, d2, d3, d4, d5, d6] = c8.slice(1, 7);
  let body;
  if ('012'.includes(d6)) body = ns + d1 + d2 + d6 + '0000' + d3 + d4 + d5;
  else if (d6 === '3') body = ns + d1 + d2 + d3 + '00000' + d4 + d5;
  else if (d6 === '4') body = ns + d1 + d2 + d3 + d4 + '00000' + d5;
  else body = ns + d1 + d2 + d3 + d4 + d5 + '0000' + d6;
  return body + chk;
}
// Same readings as the app's barcode normaliser: every plausible GTIN-14, plus a "stem" for misread check digits.
function alBarcodeKeys(raw) {
  const digits = alDigits(raw);
  const out = { gtins: new Set(), stems: new Set(), pfx: new Set() };
  const L = digits.length;
  if (L < 8 || L === 9 || L === 10 || L > 14) return out;
  const add = (g) => { const g14 = g.padStart(14, '0'); out.gtins.add(g14); out.stems.add(g14.slice(0, 13)); const z = g14.replace(/^0+/, ''); if (z.length >= 11) out.pfx.add(z); };
  if (L === 8) {
    const upca = alExpandUpcE(digits);
    if (alValidCheck(digits)) add(digits);
    if (upca && alValidCheck(upca)) add(upca);
    if (!out.gtins.size) { add(digits); if (upca) add(upca); }
  } else if (L === 11) { add(digits + alCheckDigit(digits)); if (alValidCheck('0' + digits)) add('0' + digits); }  // missing check digit, or a UPC-A that lost its leading zero
  else add(digits);
  return out;
}

/** USDA establishment numbers ("EST. M3177", "P-3177", "Est 4520A") identify the plant printed on meat, poultry and egg packages. */
function alEstIds(text) {
  const out = new Set();
  const t = String(text || '');
  if (!/\best(?:ablishment)?\b/i.test(t) && !/\b[MP]-?\d{3,5}\b/.test(t)) return out;
  for (const m of t.matchAll(/\best(?:ablishment)?\.?\s*(?:no\.?|number|#)?\s*:?\s*([A-Z]{0,2}-?\d{2,5}[A-Z]?)\b/gi)) out.add(m[1].toUpperCase().replace(/-/g, ''));
  if (out.size || /\best\b/i.test(t)) for (const m of t.matchAll(/\b([MP])-?(\d{3,5})\b/g)) out.add(m[1] + m[2]);
  return out;
}
const AL_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'pack', 'size', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'count', 'ct', 'each', 'fresh', 'organic', 'original', 'brand', 'natural', 'new', 'item', 'food', 'foods', 'product', 'products', 'grocery', 'packed', 'packaged', 'packaging', 'plastic', 'clear', 'unit', 'units', 'sizes', 'case', 'cases', 'bag', 'bags', 'box', 'boxes', 'jar', 'jars', 'carton', 'cartons', 'pouch', 'bottle', 'bottles']);
function alTokens(text) {
  const seen = new Set();
  for (const t of alNorm(text).split(' ')) {
    if (t.length >= 3 && !/^\d+$/.test(t) && !/^\d+(oz|lb|lbs|ct|pk|g|kg|ml|l|fl|gal|qt|pt)$/.test(t) && !AL_STOP.has(t)) seen.add(t);
  }
  return [...seen];
}

/** One normalised recall record. */
function alMakeRecall({ id, product, firm, reason, classification, status, date, agency, codesText, extra }) {
  const prod = alNorm(`${product || ''} ${extra || ''}`);
  const rec = {
    id: String(id || '').slice(0, 60), product: String(product || '').slice(0, 300), firm: String(firm || '').slice(0, 120),
    reason: String(reason || '').slice(0, 400), classification: String(classification || '').slice(0, 40),
    status: String(status || ''), date: String(date || ''), agency: agency || 'FDA',
    prodText: prod, text: alNorm(`${product} ${firm} ${extra || ''}`), gtins: new Set(), stems: new Set(), pfx: new Set(), est: new Set(),
  };
  rec.words = new Set(prod.split(' '));
  alEstIds(`${product || ''} ${codesText || ''} ${firm || ''}`).forEach((e) => rec.est.add(e));
  rec.padText = ' ' + rec.text + ' ';
  const blob = `${product || ''} ${codesText || ''}`;
  for (const m of blob.match(/\b\d{8,14}\b/g) || []) {
    const k = alBarcodeKeys(m);
    k.gtins.forEach((g) => rec.gtins.add(g));
    k.stems.forEach((s) => rec.stems.add(s));
    k.pfx.forEach((x) => rec.pfx.add(x));
  }
  // Notices often print the code with spaces or hyphens ("0 71430 01234 5", "8-12345-67890-1"). Only accept those when the check digit is valid.
  for (const m of blob.match(/(?<![\d.])\d{1,3}(?:[ -]\d{1,6}){2,5}(?![\d])/g) || []) {
    const d = m.replace(/\D/g, '');
    if (d.length < 8 || d.length > 14 || d.length === 9 || d.length === 10) continue;
    if (!alValidCheck(d)) { const z = d.replace(/^0+/, ''); if (z.length >= 11) rec.pfx.add(z); continue; }   // invalid check digit: usable only as a "near" hint
    const k = alBarcodeKeys(d);
    k.gtins.forEach((g) => rec.gtins.add(g));
    k.stems.forEach((x) => rec.stems.add(x));
    k.pfx.forEach((y) => rec.pfx.add(y));
  }
  return rec;
}
const alRecallActive = (r) => !/terminat|complet|closed|ended|resolved/i.test(String(r.status || ''));

/** Work that depends only on the item, done once per item instead of once per recall. */
function alPrepItem(item) {
  const brand = alNorm(item.b);
  const name = alNorm(item.n);
  return {
    item, keys: alBarcodeKeys(item.u), brand, est: alEstIds(`${item.n || ''} ${item.b || ''}`),
    brandTokens: alTokens(brand), nameTokens: alTokens(name), hasText: !!(name || brand), name,
  };
}

/** Returns { confidence, why } or null. Exact and near are by barcode; "possible" is by brand and product words. */
// Everyday food words. A product name made only of these cannot tell one brand's product from another's.
const AL_GENERIC_FOOD = new Set(('ice cream sandwich sandwiches vanilla chocolate strawberry original classic organic fresh frozen natural ' +
  'cheese chicken beef pork turkey ham bacon sausage fish salmon tuna shrimp bread buns bagels rolls milk juice water soda salad soup ' +
  'cookie cookies cake cakes pie pies pizza yogurt cereal snack snacks bars bar chips crackers cracker butter sauce pasta rice beans corn ' +
  'eggs egg apple apples orange lemon banana berries blueberry grapes carrots spinach lettuce tomato tomatoes potato potatoes onion cheddar ' +
  'mozzarella parmesan peanut almond nuts mixed whole sliced shredded diced grilled roasted baked fried crispy crunchy creamy mild sweet ' +
  'salted unsalted plain flavor flavored family size pack variety assorted deluxe premium style').split(/\s+/));

function alMatchPrepared(p, rec) {
  const keys = p.keys;
  for (const g of keys.gtins) if (rec.gtins.has(g)) return { confidence: 'exact', why: 'Barcode matches the recall notice.' };
  for (const s of keys.stems) if (rec.stems.has(s)) return { confidence: 'near', why: 'Same product code, but the check digit differs. The barcode may have been misread.' };
  // A barcode that lost (or gained) its last digit, e.g. a misread or truncated scan: the shorter number is the start of the longer one.
  for (const a of keys.pfx) for (const b of rec.pfx) {
    if (b.startsWith(a) || a.startsWith(b)) return { confidence: 'near', why: 'Barcode almost matches the recall notice (same digits, or off by the last digit). It may have been misread. Check the product.' };
  }
  if (!p.hasText) return null;

  // Same USDA plant number on the item and in the notice.
  if (p.est.size && rec.est.size) {
    for (const e of p.est) if (rec.est.has(e)) {
      const hit = p.nameTokens.some((t) => alHasWord(rec.words, t) && !/^[mp]?\d+$/.test(t) && t !== 'est');
      return hit
        ? { confidence: 'possible', why: 'Same USDA plant number (EST) and matching product words. Check the lot code and best-by date.' }
        : { confidence: 'related', why: 'Same USDA plant number (EST) as the recall, but the product name differs. Check whether it is one of the recalled products.' };
    }
  }

  const brand = p.brand;
  let nameTokens = p.nameTokens;
  // Cheap early exit: none of the item's words appear in the notice at all.
  let any = false;
  for (const t of nameTokens) { if (alHasWord(rec.words, t)) { any = true; break; } }
  if (!any) return null;

  const brandHit = brand.length >= 3 && (rec.padText.includes(' ' + brand + ' ') || rec.padText.includes(' ' + brand + 's ') || rec.padText.includes(' ' + brand + 'es '));
  if (brandHit) {
    nameTokens = nameTokens.filter((t) => !p.brandTokens.includes(t));
    if (!nameTokens.length) return null;
    const hits = nameTokens.filter((t) => alHasWord(rec.words, t));
    // The item has its own barcode and the notice lists barcodes, but not this one: likely another size or flavor, so ask for the whole name.
    const otherBarcode = keys.gtins.size > 0 && rec.gtins.size > 0;
    const need = otherBarcode ? Math.max(2, nameTokens.length) : (nameTokens.length >= 2 ? 2 : 1);
    if (hits.length >= need) {
      // Every product word present: a likely match. Only some of them: a related product from the same brand (queued in the app, but no push).
      if (hits.length === nameTokens.length) return { confidence: 'possible', why: 'Brand and product words match. Check the lot code and best-by date.' };
      return { confidence: 'related', why: 'Same brand and some matching product words. A related product may be affected. Check the name, lot code and best-by date.' };
    }
    return null;
  }
  // A brand was given but is not in the notice: the notice is about another company's product ("Kroger extra virgin olive oil" is not
  // "Kofinas garlic extra virgin olive oil"). Products with this brand are matched by barcode above, never by name alone.
  if (brand) return null;
  // No brand on the item. A short name ("baby carrots") only counts when its two words appear next to each other in the notice.
  if (!brand && nameTokens.length === 2 && nameTokens[0].length >= 4 && nameTokens[1].length >= 4) {
    const phrase = nameTokens.join(' ');
    if (rec.padText.includes(' ' + phrase + ' ') || rec.padText.includes(' ' + phrase + 's ') || rec.padText.includes(' ' + phrase + 'es ')) {
      return { confidence: 'possible', why: 'Product name matches. Check the brand, lot code and best-by date.' };
    }
    return null;
  }
  // The name has to carry the brand, so ask for at least three distinctive words, all present.
  if (nameTokens.length >= 3) {
    const hits = nameTokens.filter((t) => alHasWord(rec.words, t));
    if (hits.length === nameTokens.length) return { confidence: 'possible', why: 'Product name matches. Check the lot code and best-by date.' };
  }
  return null;
}

// ---- Pinned recalls: hand-added notices the live FDA/USDA feeds miss (for example USDA Public Health Alerts).
// The app downloads this same list (GET /recalls/pinned), and the background alert matcher uses it too, so the two always agree.
// To add or retire one: edit this list, paste the Worker into Cloudflare. No app update is needed.
// Fields use the app's recall shape. `expires` (YYYY-MM-DD) is optional; after that date the entry drops out by itself.
const AL_PINNED = [
  {
    id: 'ALDI-PRIANO-TORTELLONI-2026-11-18',
    agency: 'FDA',
    product: 'ALDI Priano Protein Carbonara Tortelloni (9 oz) and Priano Protein Herb & Cheese Tortelloni (9 oz) — Lot T9101926, Best If Used By Dec 18, 2026. Sold in Alabama, Georgia, North Carolina and South Carolina, in stores and online.',
    brand: 'ALDI Inc.',
    reason: 'Possible Clostridium botulinum contamination (botulism risk): the products may not have been stored, distributed or sold at appropriate temperatures. Do not prepare or eat them. Discard, or return to ALDI for a full refund. ALDI: (844) 484-0332. Company announcement posted by the FDA.',
    severity: 'Company announcement (FDA-posted)',
    date: '11/18/2026',
    status: 'Ongoing',
    upcs: [],
    lotCodes: ['T9101926'],
    keywords: ['priano', 'protein tortelloni', 'carbonara tortelloni', 'herb and cheese tortelloni', 'herb & cheese tortelloni'],
    raw: 'aldi priano protein carbonara tortelloni herb cheese tortelloni t9101926 clostridium botulinum botulism alabama georgia north carolina south carolina',
    expires: '2027-02-18',
  },
  {
    id: 'USDA-PHA-2026-M3177',
    agency: 'USDA FSIS',
    product: 'Betterballen Foods 6-piece Bami Rolls (Pork), 10-piece Saté Kroketten (Chicken), and 12-piece Bitterballen (Beef) — Best By Oct 2027 (EST. M3177 / P3177)',
    brand: 'Betterballen Foods LLC / Lowlands House',
    reason: 'USDA Public Health Alert: Undeclared sesame in all three products and undeclared anchovies (fish) in Worcestershire sauce in Bitterballen. Lot codes: BR-2026-01, BR-2026-02, SK-1026-01, BB-1026-01.',
    severity: 'USDA Public Health Alert',
    date: '11/06/2026',
    status: 'Public Health Alert',
    upcs: [],
    lotCodes: ['BR-2026-01', 'BR-2026-02', 'SK-1026-01', 'BB-1026-01'],
    keywords: ['bitterballen', 'bami rolls', 'sate kroketten', 'saté kroketten'],
    raw: 'betterballen foods llc lowlands house bami rolls sate kroketten saté kroketten bitterballen est. m3177 est. p3177 br-2026-01 br-2026-02 sk-1026-01 bb-1026-01 sesame anchovies fish',
    expires: '2027-11-06',
  },
];
function alPinnedActive() {
  const now = Date.now();
  return AL_PINNED.filter((p) => !p.expires || Date.parse(p.expires + 'T23:59:59Z') > now);
}
function alPinnedToRecord(p) {
  return {
    id: p.id, product: p.product, firm: p.brand || '', reason: p.reason || '', classification: p.severity || 'Pinned notice',
    status: p.status || 'Ongoing', agency: p.agency || 'RAKKA', date: p.date || '',
    codesText: [].concat(p.upcs || [], p.lotCodes || []).join(' '),
    extra: [].concat(p.keywords || [], p.raw || '').join(' '),
  };
}

function alUsdaDate(s) { const t = Date.parse(s || ''); return isNaN(t) ? null : t; }

// openFDA caps a request at 1000 rows. Ask for ongoing recalls reported in the last 12 months, newest first.
function alFdaUrl(skip) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const to = new Date(), from = new Date(Date.now() - 365 * 86400000);
  return `https://api.fda.gov/food/enforcement.json?search=status:%22Ongoing%22+AND+report_date:[${ymd(from)}+TO+${ymd(to)}]&limit=1000&skip=${skip}&sort=report_date:desc`;
}

/** Receipt line check: same matcher as the barcode check, with two receipt-only rules (a name with no brand is never flagged; "related" is ignored). */
function alReceiptMatch(index, item) {
  const raw = String((item && item.u) || '').replace(/\D/g, '');
  const pi = alPrepItem({ u: raw.length >= 8 ? raw : '', n: String((item && item.n) || '').slice(0, 160), b: String((item && item.b) || '').slice(0, 80) });
  const cands = new Set();
  for (const g of pi.keys.gtins) (index.byGtin.get(g) || []).forEach((r) => cands.add(r));
  for (const st of pi.keys.stems) (index.byStem.get(st) || []).forEach((r) => cands.add(r));
  for (const z of pi.keys.pfx) (index.byPfx.get(z.slice(0, 11)) || []).forEach((r) => cands.add(r));
  for (const t of pi.nameTokens) for (const wd of [t, t + 's', t + 'es']) (index.byWord.get(wd) || []).forEach((r) => cands.add(r));
  const order = { exact: 0, near: 1, possible: 2 };
  let best = null;
  for (const r of cands) {
    const m = alMatchPrepared(pi, r);
    if (!m || !(m.confidence in order)) continue;
    if (m.confidence === 'possible' && !pi.brand) continue;
    if (!best || order[m.confidence] < order[best.m.confidence]) best = { m, r };
  }
  return best;
}

let AL_RSS_MEMO = { at: 0, items: null };
const AL_FDA_RSS = 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml';
function alXmlText(x) {
  return String(x || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
}
/** Turn FDA recall RSS items into recall records (name and brand matching only: these notices carry no barcodes). */
function alRssRecords(xml, records) {
  const pinnedWords = alPinnedActive().flatMap((p) => p.keywords || []).map((k) => alNorm(k));
  const items = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const it of items.slice(0, 40)) {
    const tag = (n) => { const m = it.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m ? alXmlText(m[1]) : ''; };
    const title = tag('title'), link = tag('link'), desc = tag('description'), pub = tag('pubDate');
    if (!title) continue;
    const when = Date.parse(pub);
    if (!isNaN(when) && Date.now() - when > 75 * 86400000) continue;
    const nt = alNorm(title);
    if (pinnedWords.some((k) => k && nt.includes(k))) continue;   // already covered by a pinned notice
    const firm = (title.match(/^(.+?)\s+(?:Recalls?|Issues?|Expands?|Announces?|Voluntarily)\b/i) || [])[1] || '';
    const d = isNaN(when) ? '' : new Date(when);
    records.push({
      id: 'FDA-RSS-' + (link.split('/').filter(Boolean).pop() || title).slice(0, 80),
      product: title, firm, reason: desc.slice(0, 400), classification: 'Company announcement (FDA-posted)',
      status: 'Ongoing', agency: 'FDA',
      date: d ? `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}` : '',
      codesText: '', extra: desc.slice(0, 600),
    });
  }
}

async function alLoadFeed(env, { force = false } = {}) {
  const kv = env.RAKKA_COMMUNITY_DB;
  if (!force) {
    try {
      const cached = await kv.get('alfeed:v1', { type: 'json' });
      if (cached && Array.isArray(cached.records) && Date.now() - cached.at < AL_FEED_TTL_MS) return cached;
    } catch (_) {}
  }
  const records = alPinnedActive().map(alPinnedToRecord);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let fdaOk = false, usdaOk = false;
  try {
    const [fdaRes, usdaRes, rssRes] = await Promise.allSettled([
      fetch(alFdaUrl(0), { signal: ctl.signal }),
      fetch('https://www.fsis.usda.gov/fsis/api/recall/v/1', { signal: ctl.signal }),
      fetch(AL_FDA_RSS, { signal: ctl.signal, headers: { 'User-Agent': 'RAKKA-FoodSafetyApp/1.0 (contact@twinravensdigital.com)' } }),
    ]);
    if (fdaRes.status === 'fulfilled' && fdaRes.value.ok) {
      const j = await fdaRes.value.json();
      let fdaRows = (j && j.results) || [];
      // openFDA returns at most 1000 rows per request. If this year's ongoing recalls exceed that, page once more.
      const fdaTotal = Number(j && j.meta && j.meta.results && j.meta.results.total) || 0;
      if (fdaTotal > fdaRows.length && fdaRows.length >= 1000) {
        try {
          const r2 = await fetch(alFdaUrl(1000), { signal: ctl.signal });
          if (r2.ok) { const j2 = await r2.json(); fdaRows = fdaRows.concat((j2 && j2.results) || []); }
        } catch (_) { /* keep page 1 */ }
      }
      for (const r of fdaRows) {
        records.push({
          id: r.recall_number, product: r.product_description, firm: r.recalling_firm, reason: r.reason_for_recall,
          classification: r.classification, status: r.status, agency: 'FDA',
          date: r.recall_initiation_date && r.recall_initiation_date.length === 8
            ? `${r.recall_initiation_date.slice(4, 6)}/${r.recall_initiation_date.slice(6, 8)}/${r.recall_initiation_date.slice(0, 4)}` : '',
          codesText: String(r.code_info || '').slice(0, 1500),
        });
      }
      fdaOk = true;
    }
    if (usdaRes.status === 'fulfilled' && usdaRes.value.ok) {
      const j = await usdaRes.value.json();
      if (Array.isArray(j)) {
        for (const u of j.slice(0, 60)) {
          const when = alUsdaDate(u.field_recall_date);
          if (when && Date.now() - when > 120 * 86400000) continue;
          const summary = String(u.field_summary || u.field_reason || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          records.push({
            id: u.field_recall_number || `USDA-${String(u.field_title || '').slice(0, 24)}`,
            product: `${u.field_title || 'USDA notice'} ${summary}`.slice(0, 600), firm: u.field_establishment || '',
            reason: summary, classification: u.field_risk_level || u.field_recall_classification || 'USDA FSIS',
            status: u.field_closed_date ? 'Closed' : 'Ongoing', agency: 'USDA FSIS', date: u.field_recall_date || '',
            codesText: '',
          });
        }
        usdaOk = true;
      }
    }
    // FDA company announcements (the same notices as fda.gov "Recalls, Market Withdrawals & Safety Alerts"). They appear days to weeks before openFDA enforcement reports.
    if (rssRes.status === 'fulfilled' && rssRes.value.ok) {
      try { alRssRecords(await rssRes.value.text(), records); } catch (_) { /* keep the rest */ }
    }
  } catch (_) { /* fall through with whatever loaded */ } finally { clearTimeout(timer); }
  const feed = { at: Date.now(), fdaOk, usdaOk, records: records.filter((r, i) => records.findIndex((x) => x.id === r.id) === i) };
  if (fdaOk || usdaOk) {
    try { await kv.put('alfeed:v1', JSON.stringify(feed), { expirationTtl: 3600 }); } catch (_) {}
  } else {
    try {
      const stale = await kv.get('alfeed:v1', { type: 'json' });
      if (stale && Array.isArray(stale.records)) {
        const have = new Set(stale.records.map((r) => r.id));
        for (const p of alPinnedActive()) if (!have.has(p.id)) stale.records.push(alPinnedToRecord(p));
        return stale;
      }
    } catch (_) {}
  }
  return feed;
}


// Short in-memory copy of the recall feed so a burst of scans does not read storage every time.
let AL_MEMO = { at: 0, feed: null };
async function alLoadFeedMemo(env) {
  if (AL_MEMO.feed && Date.now() - AL_MEMO.at < 60000) return AL_MEMO.feed;
  const feed = await alLoadFeed(env);
  AL_MEMO = { at: Date.now(), feed };
  return feed;
}

/** Built once per run and shared by every device: which recalls mention which word or barcode. */
function alBuildIndex(recalls) {
  const byWord = new Map(), byGtin = new Map(), byStem = new Map(), byPfx = new Map(), byEst = new Map();
  const add = (map, key, r) => { let a = map.get(key); if (!a) { a = []; map.set(key, a); } if (a[a.length - 1] !== r) a.push(r); };
  for (const r of recalls) {
    if (!r.id || !alRecallActive(r)) continue;
    r.words.forEach((w) => add(byWord, w, r));
    r.gtins.forEach((g) => add(byGtin, g, r));
    r.stems.forEach((st) => add(byStem, st, r));
    r.pfx.forEach((z) => add(byPfx, z.slice(0, 11), r));
    r.est.forEach((e) => add(byEst, e, r));
  }
  return { byWord, byGtin, byStem, byPfx, byEst };
}

let AL_INDEX_CACHE = { at: -1, index: null };
function alIndexFor(feed) {
  if (AL_INDEX_CACHE.index && AL_INDEX_CACHE.at === feed.at) return AL_INDEX_CACHE.index;
  const index = alBuildIndex((feed.records || []).map(alMakeRecall));
  AL_INDEX_CACHE = { at: feed.at, index };
  return index;
}
const alHash = (str) => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };

/** Matches one device's items against the feed and queues new alerts. Returns the number of new alerts. */
function alProcessDevice(rec, index) {
  rec.seen = rec.seen && typeof rec.seen === 'object' ? rec.seen : {};
  rec.pending = Array.isArray(rec.pending) ? rec.pending : [];
  const items = Array.isArray(rec.items) ? rec.items : [];
  const byRecall = new Map();
  for (const it of items) {
    const pi = alPrepItem(it);
    const cands = new Set();
    for (const g of pi.keys.gtins) (index.byGtin.get(g) || []).forEach((r) => cands.add(r));
    for (const st of pi.keys.stems) (index.byStem.get(st) || []).forEach((r) => cands.add(r));
    for (const e of pi.est) (index.byEst.get(e) || []).forEach((r) => cands.add(r));
    for (const z of pi.keys.pfx) (index.byPfx.get(z.slice(0, 11)) || []).forEach((r) => cands.add(r));
    for (const t of pi.nameTokens) for (const w of [t, t + 's', t + 'es']) (index.byWord.get(w) || []).forEach((r) => cands.add(r));
    for (const r of cands) {
      if (rec.seen[r.id]) continue;
      const m = alMatchPrepared(pi, r);
      if (!m) continue;
      let list = byRecall.get(r);
      if (!list) { list = []; byRecall.set(r, list); }
      if (list.length < 6) list.push({ name: String(it.n || it.b || 'Watchlist item').slice(0, 120), confidence: m.confidence, why: m.why });
    }
  }
  let added = 0, strong = 0;
  for (const [r, matches] of byRecall) {
    if (matches.some((m) => m.confidence !== 'related')) strong++;
    rec.seen[r.id] = Date.now();
    rec.pending.push({
      id: r.id, title: r.product.slice(0, 200), agency: r.agency, cls: r.classification, date: r.date,
      reason: r.reason.slice(0, 240), matches, at: Date.now(),
    });
    added++;
  }
  // Keep the records small: drop the oldest.
  // When the queue is full, drop "related" notices first so they can never push out a likely or exact one.
  while (rec.pending.length > AL_MAX_PENDING) {
    const idx = rec.pending.findIndex((p) => (p.matches || []).every((m) => m.confidence === 'related'));
    rec.pending.splice(idx >= 0 ? idx : 0, 1);
  }
  const seenKeys = Object.keys(rec.seen);
  if (seenKeys.length > AL_MAX_SEEN) {
    seenKeys.sort((a, b) => rec.seen[a] - rec.seen[b]).slice(0, seenKeys.length - AL_MAX_SEEN).forEach((k) => delete rec.seen[k]);
  }
  alProcessDevice.lastStrong = strong;   // read synchronously by the caller: how many of the new recalls deserve a push
  return added;
}

// ---- Push delivery (Firebase Cloud Messaging HTTP v1; one sender covers Android and iPhone in the store app) ----
let AL_FCM_CACHE = { token: '', exp: 0 };
const alB64u = (buf) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

async function alFcmAccess(env) {
  if (AL_FCM_CACHE.token && AL_FCM_CACHE.exp > Date.now() + 60000) return { token: AL_FCM_CACHE.token, projectId: AL_FCM_CACHE.projectId };
  let sa;
  try { sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch (_) { return null; }
  if (!sa || !sa.private_key || !sa.client_email || !sa.project_id) return null;
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const head = alB64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = alB64u(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const pem = String(sa.private_key).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claim}`));
  const jwt = `${head}.${claim}.${alB64u(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) return null;
  const j = await res.json();
  AL_FCM_CACHE = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000, projectId: sa.project_id };
  return { token: AL_FCM_CACHE.token, projectId: sa.project_id };
}

/** Generic text only: the product never passes through Apple's or Google's push services. Returns 'ok' | 'gone' | 'skip' | 'fail'. */
async function alSendPush(env, pushToken, count, dbg, bare) {
  if (!pushToken || !env.FCM_SERVICE_ACCOUNT) return 'skip';
  try {
    const acc = await alFcmAccess(env);
    if (!acc) return 'skip';
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${acc.projectId}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token: pushToken,
        notification: { title: 'RAKKA recall alert', body: count > 1 ? `${count} recalls may affect items on your watchlist. Open RAKKA to check.` : 'A recall may affect an item on your watchlist. Open RAKKA to check.' },
        android: { priority: 'HIGH' },
        ...(bare ? {} : {
          data: { type: 'recall', count: String(count) },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        }),
      } }),
    });
    if (dbg) dbg.status = res.status;
    if (res.ok) { if (dbg) { try { dbg.body = String(await res.text()).slice(0, 200); } catch (_) {} } return 'ok'; }
    if (res.status === 404 || res.status === 400) {
      const t = await res.text();
      if (dbg) dbg.body = String(t).slice(0, 240);
      if (/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/.test(t)) return 'gone';
    }
    if (dbg) { try { dbg.body = String(await res.text()).slice(0, 240); } catch (_) {} }
    return 'fail';
  } catch (e) { if (dbg) dbg.body = String(e && e.message || e).slice(0, 160); return 'fail'; }
}

/**
 * Cron entry point. Scales by doing no per-device work unless a recall is new:
 *  1. fetch the feed, find recalls not seen in an earlier cycle;
 *  2. if there are none, stop (this is almost every run);
 *  3. otherwise check every device against ONLY those new recalls, in pages, resuming on the next run if time or call limits are hit;
 *  4. when the last device is done, remember those recalls so they are never re-checked.
 * Devices that register later are checked against the whole feed at registration.
 */
async function alRunScheduled(env) {
  if (!env || !env.RAKKA_COMMUNITY_DB) return { processed: 0 };
  const kv = env.RAKKA_COMMUNITY_DB;
  const startedAt = Date.now();
  try {
    const lock = await kv.get('alrun:lock');
    if (lock && startedAt - Number(lock) < 8 * 60 * 1000) return { skipped: 'another run is active' };
    await kv.put('alrun:lock', String(startedAt), { expirationTtl: 600 });
  } catch (_) {}
  try {
    let state = null;
    try { state = await kv.get('alrun:state', { type: 'json' }); } catch (_) {}
    if (!state || !Array.isArray(state.recalls)) {
      const feed = await alLoadFeed(env, { force: true });
      if (!feed.records || !feed.records.length) return { processed: 0, note: 'no feed' };
      let known = new Set();
      try { known = new Set((await kv.get('alknown', { type: 'json' })) || []); } catch (_) {}
      const fresh = feed.records.filter((r) => r.id && alRecallActive(r) && !known.has(String(r.id)))
        .map((r) => ({ ...r, codesText: String(r.codesText || '').slice(0, 1500) }));
      if (!fresh.length) return { processed: 0, newRecalls: 0 };
      state = { recalls: fresh, cursor: '', processed: 0, queued: 0, pushed: 0, startedAt };
    }
    const index = alBuildIndex(state.recalls.map(alMakeRecall));

    const handle = async (name) => {
      const deviceId = name.slice(AL_PREFIX.length);
      let rec;
      try { rec = await kv.get(name, { type: 'json' }); } catch (_) { return; }
      if (!rec) return;
      // Alerts are a Plus feature: when the entitlement has lapsed or a code was revoked, erase the watchlist copy.
      if (!(await checkPlus(env, rec.tk, deviceId))) { try { await kv.delete(name); } catch (_) {} return; }
      const added = alProcessDevice(rec, index);
      const strong = alProcessDevice.lastStrong || 0;
      state.processed++;
      if (added > 0) {
        state.queued += added;
        const r = strong > 0 ? await alSendPush(env, rec.pt, strong) : 'skip';
        if (r === 'ok') state.pushed++;
        if (r === 'gone') rec.pt = '';
        try { await kv.put(name, JSON.stringify(rec), { expirationTtl: AL_TTL_SECONDS }); } catch (_) {}
      }
    };

    let complete = false;
    let handledThisRun = 0;
    while (true) {
      const page = await kv.list({ prefix: AL_PREFIX, cursor: state.cursor || undefined, limit: 500 });
      const names = page.keys.map((k) => k.name);
      for (let n = 0; n < names.length; n += AL_CONCURRENCY) {
        await Promise.all(names.slice(n, n + AL_CONCURRENCY).map(handle));
      }
      handledThisRun += names.length;
      state.cursor = page.list_complete ? '' : (page.cursor || '');
      if (page.list_complete) { complete = true; break; }
      if (handledThisRun >= AL_DEVICES_PER_RUN || Date.now() - startedAt > AL_RUN_BUDGET_MS) break;
    }

    if (complete) {
      let known = [];
      try { known = (await kv.get('alknown', { type: 'json' })) || []; } catch (_) {}
      const merged = [...known, ...state.recalls.map((r) => String(r.id))];
      const trimmed = merged.slice(-AL_KNOWN_CAP);
      await kv.put('alknown', JSON.stringify(trimmed));
      await kv.delete('alrun:state');
    } else {
      await kv.put('alrun:state', JSON.stringify(state), { expirationTtl: 86400 });
    }
    return { processed: state.processed, queued: state.queued, pushed: state.pushed, complete, newRecalls: state.recalls.length };
  } finally {
    try { await kv.delete('alrun:lock'); } catch (_) {}
  }
}

function alCleanItems(raw) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || typeof it !== 'object') continue;
    const n = String(it.n || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const b = String(it.b || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const u = alDigits(it.u).slice(0, 14);
    if (!n && !b && !u) continue;
    const key = `${u}|${alNorm(n)}|${alNorm(b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ n, b, u });
    if (out.length >= AL_MAX_ITEMS) break;
  }
  return out;
}

const alSecretOk = (rec, secret) => !!(rec && rec.sec && typeof secret === 'string' && secret.length >= 16 && secret === rec.sec);

/** Handles /alerts/* and /data/delete. Returns a Response, or null when the path is not ours. */
async function alHandleRequest(request, env, url, replyHeaders, ctx) {
  const path = url.pathname;
  const isAlerts = path.startsWith('/alerts/');
  if (!(request.method === 'POST' && (isAlerts || path === '/data/delete'))) return null;
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...replyHeaders, 'Cache-Control': 'no-store' } });
  if (!env || !env.RAKKA_COMMUNITY_DB) return reply({ success: false, error: 'Storage is not bound to this Worker.' }, 503);
  const kv = env.RAKKA_COMMUNITY_DB;
  let b = {};
  try { b = await request.json(); } catch (_) {}
  const deviceId = String(b.deviceId || '').trim().slice(0, 80);
  const secret = String(b.secret || '').slice(0, 80);
  if (!deviceId) return reply({ success: false, error: 'deviceId required' }, 400);
  const key = AL_PREFIX + deviceId;

  if (path === '/alerts/register') {
    if (secret.length < 16) return reply({ success: false, error: 'A device secret is required.' }, 400);
    const plus = await checkPlus(env, b.plusToken, deviceId);
    if (!plus) return reply({ success: false, error: 'Background recall alerts are a RAKKA Plus feature.', needsPlus: true }, 403);
    const existing = await kv.get(key, { type: 'json' });
    if (existing && !alSecretOk(existing, secret)) return reply({ success: false, error: 'This device is already registered with a different secret.' }, 403);
    const rec = existing || { v: 1, seen: {}, pending: [] };
    const items = alCleanItems(b.items);
    const itemsHash = alHash(JSON.stringify(items));
    const token = String(b.plusToken || '').slice(0, 600);
    const pushToken = (typeof b.pushToken === 'string' && b.pushToken.length >= 20 && b.pushToken.length <= 400) ? b.pushToken : '';
    const feed = await alLoadFeed(env);
    const feedOk = !!(feed.fdaOk || feed.usdaOk);
    // Nothing changed and the copy is fresh: no need to rewrite it (saves a storage write on most app opens).
    if (existing && existing.ih === itemsHash && existing.tk === token && (!pushToken || existing.pt === pushToken) && Date.now() - (existing.upd || 0) < 12 * 3600 * 1000) {
      return reply({ success: true, watching: items.length, queued: (existing.pending || []).length, newAlerts: 0, checkedAt: feed.at || Date.now(), feedOk });
    }
    rec.sec = secret;
    rec.tk = token;
    rec.items = items;
    rec.ih = itemsHash;
    if (pushToken) { rec.pt = pushToken; rec.pf = String(b.platform || '').slice(0, 12); }
    rec.upd = Date.now();
    // Check right away against everything in the feed, so what the person sees is already up to date.
    const added = alProcessDevice(rec, alIndexFor(feed));
    await kv.put(key, JSON.stringify(rec), { expirationTtl: AL_TTL_SECONDS });
    return reply({ success: true, watching: rec.items.length, queued: rec.pending.length, newAlerts: added, checkedAt: feed.at || Date.now(), feedOk });
  }

  if (path === '/alerts/pending') {
    const rec = await kv.get(key, { type: 'json' });
    if (!alSecretOk(rec, secret)) return reply({ success: false, error: 'Not registered.' }, 403);
    return reply({ success: true, pending: rec.pending || [], watching: (rec.items || []).length, checkedAt: rec.chk || 0 });
  }

  if (path === '/alerts/ack') {
    const rec = await kv.get(key, { type: 'json' });
    if (!alSecretOk(rec, secret)) return reply({ success: false, error: 'Not registered.' }, 403);
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x).slice(0, 60)));
    rec.pending = (rec.pending || []).filter((p) => !ids.has(p.id));
    await kv.put(key, JSON.stringify(rec), { expirationTtl: AL_TTL_SECONDS });
    return reply({ success: true, remaining: rec.pending.length });
  }

  if (path === '/alerts/test') {
    // Plus testers: sends one generic test push to this device so push delivery can be checked without waiting for a recall.
    const rec = await kv.get(key, { type: 'json' });
    if (!alSecretOk(rec, secret)) return reply({ success: false, error: 'Not registered.' }, 403);
    const plus = await checkPlus(env, b.plusToken, deviceId);
    if (!plus) return reply({ success: false, error: 'Plus required.', needsPlus: true }, 403);
    if (Date.now() - (rec.tst || 0) < 30000) return reply({ success: false, result: 'wait', error: 'Please wait a few seconds between tests.' }, 429);
    let tokenUpdated = false;
    if (typeof b.pushToken === 'string' && b.pushToken.length >= 20 && b.pushToken.length <= 400 && b.pushToken !== rec.pt) { rec.pt = b.pushToken; tokenUpdated = true; }
    if (!rec.pt) return reply({ success: true, result: 'no-token' });
    if (!env.FCM_SERVICE_ACCOUNT) return reply({ success: true, result: 'no-server-key' });
    rec.tst = Date.now();
    await kv.put(key, JSON.stringify(rec), { expirationTtl: AL_TTL_SECONDS });
    const dbg = {};
    const wait = Math.min(15, Math.max(0, Number(b.delay) || 0));
    if (wait && ctx && typeof ctx.waitUntil === 'function') {
      // Reply at once and send later in the background, so closing the app does not cancel the send.
      const pt = rec.pt;
      ctx.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, wait * 1000));
        const res2 = await alSendPush(env, pt, 1, {}, true);
        console.log('alerts/test delayed push result: ' + res2);
      })());
      return reply({ success: true, result: 'ok', fcmStatus: 0, fcmDetail: 'sending in ' + wait + ' seconds', serverTail: String(rec.pt).slice(-6), tokenUpdated, build: 'v27-bg-delay' });
    }
    const result = await alSendPush(env, rec.pt, 1, dbg, true);
    console.log('alerts/test push result: ' + result);
    return reply({ success: true, result, fcmStatus: dbg.status || 0, fcmDetail: dbg.body || '', serverTail: String(rec.pt).slice(-6), tokenUpdated, build: 'v26-delay' });
  }

  if (path === '/alerts/unregister') {
    const rec = await kv.get(key, { type: 'json' });
    if (rec && !alSecretOk(rec, secret)) return reply({ success: false, error: 'Not authorised.' }, 403);
    if (rec) await kv.delete(key);
    return reply({ success: true });
  }

  if (path === '/data/delete') {
    // Erases what the server holds for this device. Random usage counters (receipt limit, one-time trial marker)
    // hold no personal data and are left to expire, so deleting and reinstalling cannot be used to reset them.
    const rec = await kv.get(key, { type: 'json' });
    if (rec && !alSecretOk(rec, secret)) return reply({ success: false, error: 'Not authorised.' }, 403);
    let alertsDeleted = false, seatFreed = false;
    if (rec) { await kv.delete(key); alertsDeleted = true; }
    const plus = await checkPlus(env, b.plusToken, deviceId);
    if (plus && plus.k === 'code' && plus.c) {
      const devKey = `plusdev:${plus.c}`;
      const devs = await kv.get(devKey, { type: 'json' });
      if (Array.isArray(devs) && devs.includes(deviceId)) {
        await kv.put(devKey, JSON.stringify(devs.filter((d) => d !== deviceId)));
        seatFreed = true;
      }
    }
    return reply({ success: true, alertsDeleted, seatFreed });
  }

  return reply({ success: false, error: 'Unknown endpoint' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    // 1. Hardened CORS Preflight (Explicit 204 No Content + Custom Client & Auth Headers)
    const reqOrigin = request.headers.get('Origin');
    const allowedOrigins = getAllowedOrigins(env, request);
    const originOk = !reqOrigin || allowedOrigins.includes(reqOrigin);
    const allowOriginHeader = (reqOrigin && originOk) ? reqOrigin : allowedOrigins[0];
    if (request.method === 'OPTIONS') {
      if (!originOk) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Vary': 'Origin',
          'Access-Control-Allow-Origin': allowOriginHeader,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-rakka-client-version',
          'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const corsHeaders = {
      'Vary': 'Origin',
      'Access-Control-Allow-Origin': allowOriginHeader,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-rakka-client-version',
      'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    };

    if (request.method === 'POST' && !originOk) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // 2. Health check / status
        // Diagnostic: Query Google ModelService.ListModels to see exactly which models this API key is allowed to use
    if (url.pathname === '/models' || url.pathname === '/api/models') {
      if (!env || !env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
      }
      const apiKey = resolveGeminiApiKey(env).key;
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'No API key provided. Pass ?key= or configure GEMINI_API_KEY.' }), { status: 400, headers: corsHeaders });
      }
      try {
        const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': apiKey }
        });
        const listData = await listRes.json();
        return new Response(JSON.stringify({
          status: listRes.status,
          modelCount: (listData.models || []).length,
          models: (listData.models || []).map(m => ({
            name: m.name,
            displayName: m.displayName,
            supportedMethods: m.supportedGenerationMethods
          }))
        }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

        if (url.hostname.startsWith('privacy.') || url.pathname === '/privacy' || url.pathname === '/privacy-policy') {
      return new Response(PRIVACY_POLICY_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Pinned recall notices (hand-added; the app and the background alerts read the same list)
    if (request.method === 'GET' && url.pathname === '/recalls/pinned') {
      const rlPin = checkEdgeRateLimit(request, 'pinned');
      if (!rlPin.allowed) {
        return new Response(JSON.stringify({ success: false, error: 'Too many requests.' }), { status: 429, headers: { ...corsHeaders, ...rlPin.headers } });
      }
      // FDA company announcements ride along with the pinned list so the app's recall list shows them right away (they reach openFDA days later).
      let rssItems = [];
      try {
        if (!AL_RSS_MEMO.items || Date.now() - AL_RSS_MEMO.at > 600000) {
          const rr = await fetch(AL_FDA_RSS, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'RAKKA-FoodSafetyApp/1.0 (contact@twinravensdigital.com)' } });
          if (rr.ok) { const tmp = []; alRssRecords(await rr.text(), tmp); AL_RSS_MEMO = { at: Date.now(), items: tmp }; }
        }
        rssItems = (AL_RSS_MEMO.items || []).map((r) => ({
          id: r.id, agency: 'FDA', product: r.product, brand: r.firm, reason: r.reason || 'FDA-posted company announcement. See the FDA recall page for details.',
          severity: r.classification, date: r.date, status: 'Ongoing', upcs: [], lotCodes: [], keywords: [], raw: alNorm(`${r.product} ${r.firm} ${r.extra || ''}`), pinned: true,
        }));
      } catch (_) { /* pinned list still returned */ }
      return new Response(JSON.stringify({ success: true, at: Date.now(), items: [...alPinnedActive().map(({ expires, ...p }) => ({ ...p, pinned: true })), ...rssItems] }),
        { headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' } });
    }

    // Is this barcode (or product) on an active FDA/USDA recall? Uses the same matcher as the background alerts,
    // so barcodes printed with spaces or hyphens in the notice are found too.
    if (request.method === 'GET' && url.pathname === '/recall-check') {
      const rlRc = checkEdgeRateLimit(request, 'recall-check');
      if (!rlRc.allowed) {
        return new Response(JSON.stringify({ success: false, error: 'Too many requests.' }), { status: 429, headers: { ...corsHeaders, ...rlRc.headers } });
      }
      const upc = String(url.searchParams.get('upc') || '').replace(/\D/g, '').slice(0, 14);
      const nm = String(url.searchParams.get('name') || '').slice(0, 160);
      const br = String(url.searchParams.get('brand') || '').slice(0, 80);
      if (upc.length < 8 && !nm) {
        return new Response(JSON.stringify({ success: false, error: 'Send a barcode.' }), { status: 400, headers: corsHeaders });
      }
      try {
        const feed = await alLoadFeedMemo(env);
        const index = alIndexFor(feed);
        const pi = alPrepItem({ u: upc, n: nm, b: br });
        const cands = new Set();
        for (const g of pi.keys.gtins) (index.byGtin.get(g) || []).forEach((r) => cands.add(r));
        for (const st of pi.keys.stems) (index.byStem.get(st) || []).forEach((r) => cands.add(r));
        for (const z of pi.keys.pfx) (index.byPfx.get(z.slice(0, 11)) || []).forEach((r) => cands.add(r));
        const order = { exact: 0, near: 1, possible: 2, related: 3 };
        const matches = [];
        for (const r of cands) {
          const m = alMatchPrepared(pi, r);
          if (m) matches.push({ confidence: m.confidence, why: m.why, id: r.id, product: r.product, firm: r.firm, reason: r.reason, classification: r.classification, agency: r.agency, date: r.date, status: r.status });
        }
        matches.sort((a, b) => order[a.confidence] - order[b.confidence]);
        return new Response(JSON.stringify({ success: true, feedOk: !!(feed.fdaOk || feed.usdaOk), checkedAt: feed.at || Date.now(), matches: matches.slice(0, 3) }),
          { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: 'Recall check unavailable.' }), { status: 503, headers: corsHeaders });
      }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      const { key, source } = resolveGeminiApiKey(env);
      const hasKey = Boolean(key && key.length > 0);
      return new Response(JSON.stringify({
        status: 'online',
        service: 'RAKKA Cloud Edge Hook',
        version: '1.4.2',
        build: '2026-11-20-v22-plain-push',
        ai_vision_key_configured: hasKey,
        key_source: source,
        key_preview: hasKey ? 'configured' : 'NONE',
        rate_limiting: {
          enabled: true,
          window_seconds: 60,
          limits_per_ip: RATE_LIMIT_CONFIG
        },
        cors_preflight: '204_no_content_hardened',
        detected_env_keys: env ? Object.keys(env) : [],
        timestamp: new Date().toISOString()
      }), { headers: corsHeaders });
    }

    // 3. GET /lookup?upc=...
    if (url.pathname === '/lookup' || url.pathname === '/api/lookup') {
      const rawUpc = url.searchParams.get('upc') || '';
      const cleanUpc = rawUpc.replace(/\D/g, '');
      if (!cleanUpc || cleanUpc.length < 6) {
        return new Response(JSON.stringify({ error: 'Valid barcode digits required' }), { status: 400, headers: corsHeaders });
      }

      const uniqueCodes = getNormalizedBarcodeVariants(cleanUpc);

      // Tier 1: Check Cloudflare KV Community Cache across all normalized barcode variants (~15ms)
      if (env && env.RAKKA_COMMUNITY_DB) {
        try {
          const kvRaw = await Promise.all(
            uniqueCodes.map(codeVar => env.RAKKA_COMMUNITY_DB.getWithMetadata(`upc:${codeVar}`, { type: 'json' }).then(r => ({ key: `upc:${codeVar}`, value: r && r.value, meta: r && r.metadata })).catch(() => null))
          );
          const hitRow = kvRaw.find(r => r && r.value && r.value.name && !r.value.name.startsWith('Retail Grocery Item'));
          const cached = hitRow ? hitRow.value : null;
          if (cached) {
            // Remember that this product is being scanned (at most once a week per product), so the phone catalog can favor popular items.
            try {
              const seen = Number(hitRow.meta && hitRow.meta.seen) || 0;
              if (Date.now() - seen > 7 * 86400000) ctx.waitUntil(env.RAKKA_COMMUNITY_DB.put(hitRow.key, JSON.stringify(cached), { metadata: { seen: Date.now() } }).catch(() => {}));
            } catch (_) {}
            return new Response(JSON.stringify({
              found: true,
              source: 'community_cache',
              product: cached
            }), { headers: corsHeaders });
          }
        } catch (kvErr) {
          console.warn('KV read error:', kvErr);
        }
      }

      // Tier 2: Multi-Cluster Open Food Facts Query (World + US Mirror)
      let offProduct = null;
      const offDiag = [];   // why Open Food Facts gave nothing (shown only when no registry had the product)

      try {
        // One careful request at a time instead of four at once: Open Food Facts limits how many requests each address may send,
        // and Cloudflare shares addresses between many apps. Most-likely form first (13 digits), then at most two other forms.
        const offOrder = [cleanUpc.length <= 13 ? cleanUpc.padStart(13, '0') : cleanUpc, ...uniqueCodes]
          .filter((c, i, a) => a.indexOf(c) === i).slice(0, 3);
        const offStart = Date.now();
        const offOne = async (q) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${q}.json`, {
              headers: { 'User-Agent': 'RAKKA-FoodSafetyApp/1.0 (contact@twinravensdigital.com)' },
              signal: AbortSignal.timeout(7000)
            });
            if (r.status === 429 && attempt === 0 && Date.now() - offStart < 5000) {   // asked to slow down: wait a moment, try once more
              offDiag.push('HTTP 429');
              await new Promise((res) => setTimeout(res, 500 + Math.floor(Math.random() * 500)));
              continue;
            }
            if (!r.ok) { offDiag.push('HTTP ' + r.status); return r.status === 429 ? 'limited' : null; }
            const data = await r.json();
            if (data && data.status === 1 && data.product) return data.product;
            if (data) offDiag.push('status ' + data.status);
            return null;
          }
          return null;
        };
        const offAny = (async () => {
          for (const q of offOrder) {
            if (Date.now() - offStart > 9000) break;
            let prod = null;
            try { prod = await offOne(q); } catch (err) { offDiag.push(String((err && err.name) || 'error')); }
            if (prod === 'limited') break;   // Open Food Facts is refusing us: do not keep hammering it
            if (prod) return prod;
          }
          throw new Error('Not found');
        })();
        // Keep going and cache the result even if the phone gave up waiting (slow first lookup), so the next scan is instant.
        ctx.waitUntil(offAny.then(async (prod) => {
          const nm = prod.product_name || prod.product_name_en || prod.generic_name;
          if (!(env && env.RAKKA_COMMUNITY_DB) || !nm || nm.length < 2) return;
          const b12 = cleanUpc.length === 13 && cleanUpc.startsWith('0') ? cleanUpc.substring(1) : cleanUpc.padStart(12, '0');
          const rec = JSON.stringify({
            upc: cleanUpc, name: nm,
            brand: prod.brands || prod.brand_owner || (prod.brands_tags && prod.brands_tags[0]) || 'Packaged Grocery',
            ingredients: prod.ingredients_text_en || prod.ingredients_text || '',
            additives: prod.additives_tags || [], allergens: prod.allergens_tags || []
          });
          await Promise.all([env.RAKKA_COMMUNITY_DB.put(`upc:${b12}`, rec), env.RAKKA_COMMUNITY_DB.put(`upc:0${b12}`, rec)]);
        }).catch(() => {}));
        offProduct = await offAny;
      } catch (e) {}

      if (offProduct) {
        const name = offProduct.product_name || offProduct.product_name_en || offProduct.generic_name;
        const brand = offProduct.brands || offProduct.brand_owner || offProduct.brands_tags?.[0] || 'Packaged Grocery';
        const ingredients = offProduct.ingredients_text_en || offProduct.ingredients_text || '';

        if (name && name.length > 1) {
          const resolved = {
            upc: cleanUpc,
            name: name,
            brand: brand,
            ingredients: ingredients,
            additives: offProduct.additives_tags || [],
            allergens: offProduct.allergens_tags || []
          };

          // Dual-index in KV Community DB whenever a verified product name is resolved
          if (env && env.RAKKA_COMMUNITY_DB && !name.startsWith('Retail Grocery Item')) {
            const base12 = cleanUpc.length === 13 && cleanUpc.startsWith('0') ? cleanUpc.substring(1) : cleanUpc.padStart(12, '0');
            ctx.waitUntil(Promise.all([
              env.RAKKA_COMMUNITY_DB.put(`upc:${base12}`, JSON.stringify(resolved), { metadata: { seen: Date.now() } }),
              env.RAKKA_COMMUNITY_DB.put(`upc:0${base12}`, JSON.stringify(resolved), { metadata: { seen: Date.now() } })
            ]));
          }

          return new Response(JSON.stringify({
            found: true,
            source: 'open_food_facts',
            product: resolved
          }), { headers: corsHeaders });
        }
      }

      // Tier 3: USDA FoodData Central Multi-Variant Query
      try {
        const usdaKey = (env && env.USDA_API_KEY) || 'DEMO_KEY';
        const usdaQueryStr = uniqueCodes.slice(0, 3).join(' ');
        const usdaRes = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(usdaQueryStr)}&dataType=Branded&pageSize=8&api_key=${usdaKey}`);
        if (usdaRes.ok) {
          const usdaData = await usdaRes.json();
          if (usdaData && Array.isArray(usdaData.foods)) {
            const match = usdaData.foods.find(f => {
              const gtin = String(f.gtinUpc || '').replace(/\D/g, '');
              return uniqueCodes.includes(gtin) || gtin.padStart(12, '0') === cleanUpc.padStart(12, '0') || gtin.padStart(13, '0') === cleanUpc.padStart(13, '0');
            });

            if (match && match.description) {
              const rawBrand = match.brandName || match.brandOwner || 'Grocery Brand';
              const cleanBrand = rawBrand.replace(/,?\s*(Inc\.?|LLC|Corporation|Corp\.?|Co\.?|Ltd\.?)\b/gi, '').trim();
              const resolved = {
                upc: cleanUpc,
                name: match.description,
                brand: cleanBrand || 'Grocery Brand',
                ingredients: match.ingredients || '',
                additives: [],
                allergens: []
              };

              if (env && env.RAKKA_COMMUNITY_DB) {
                const base12 = cleanUpc.length === 13 && cleanUpc.startsWith('0') ? cleanUpc.substring(1) : cleanUpc.padStart(12, '0');
                ctx.waitUntil(Promise.all([
                  env.RAKKA_COMMUNITY_DB.put(`upc:${base12}`, JSON.stringify(resolved), { metadata: { seen: Date.now() } }),
                  env.RAKKA_COMMUNITY_DB.put(`upc:0${base12}`, JSON.stringify(resolved), { metadata: { seen: Date.now() } })
                ]));
              }

              return new Response(JSON.stringify({
                found: true,
                source: 'usda_fooddata',
                product: resolved
              }), { headers: corsHeaders });
            }
          }
        }
      } catch (uErr) {}

      // Tier 4: GS1 Manufacturer Prefix Directory
      const GS1_DIRECTORY = {
        // Aldi Private Labels
        '406936': "Mama Cozzi's Pizza Kitchen (Aldi)",
        '406145': "Clancy's / Simply Nature (Aldi)",
        '406146': "Specially Selected / Aldi",
        '406200': "Aldi Private Label",
        '406': "Aldi Brand (Mama Cozzi's / Clancy's)",
        '408860': "Aldi Brand (Millville / Friendly Farms)",
        '409910': "Bake Shop / Simply Nature / Millville (Aldi)",
        '409920': "Park Street Deli / Kirkwood (Aldi)",
        '4099': "Aldi Brand (Simply Nature / Millville)",
        '041498': "Aldi Brand (Friendly Farms / Happy Farms / L'oven Fresh)",
        '41498': "Aldi Brand (Friendly Farms / Happy Farms / L'oven Fresh)",
        // Major US Supermarket Private Labels
        '078742': 'Great Value (Walmart)',
        '78742': 'Great Value (Walmart)',
        '681131': 'Marketside / Sam\'s Choice (Walmart)',
        '068113': 'Marketside / Sam\'s Choice (Walmart)',
        '193968': "Member's Mark (Sam's Club)",
        '085239': 'Good & Gather / Favorite Day (Target)',
        '85239': 'Good & Gather / Favorite Day (Target)',
        '049200': 'Market Pantry (Target)',
        '011110': 'Kroger / Simple Truth / Private Selection',
        '11110': 'Kroger / Simple Truth / Private Selection',
        '096619': 'Kirkland Signature (Costco)',
        '96619': 'Kirkland Signature (Costco)',
        '099482': '365 Whole Foods Market',
        '99482': '365 Whole Foods Market',
        '009948': '365 Whole Foods Market',
        '0000': "Trader Joe's",
        '886926': 'Meijer Brand',
        '708820': 'Meijer Brand',
        '713733': 'Meijer / True Goodness',
        '719283': "Meijer / Frederik's",
        '041220': 'H-E-B / Central Market',
        '41220': 'H-E-B / Central Market',
        '041415': 'Publix / GreenWise',
        '41415': 'Publix / GreenWise',
        '021130': 'Signature SELECT / O Organics / Lucerne (Safeway / Albertsons)',
        '21130': 'Signature SELECT / O Organics (Safeway / Albertsons)',
        '077890': 'Wegmans Brand',
        '77890': 'Wegmans Brand',
        '030034': "Giant Eagle / Nature's Basket",
        '30034': "Giant Eagle / Nature's Basket",
        '075450': 'Hy-Vee Brand',
        '75450': 'Hy-Vee Brand',
        '035826': "Food Lion / Nature's Promise",
        '688267': "Stop & Shop / Giant / Nature's Promise",
        '041190': 'ShopRite / Bowl & Basket / Wholesome Pantry',
        '874875': 'Sprouts Farmers Market',
        '646670': 'Sprouts Farmers Market',
        '070038': 'WinCo Foods',
        '020735': 'Save A Lot / Coburn Farms',
        '036800': 'Food Club / Full Circle (Topco)',
        '072036': 'Clover Valley (Dollar General)',
        '041735': 'Price Chopper / Market 32',
        '041380': 'Schnucks Brand',
        '070253': 'Our Family / SpartanNash',
        // Beverages, Sparkling Water & Energy
        '049000': 'Coca-Cola',
        '49000': 'Coca-Cola',
        '012000': 'PepsiCo',
        '12000': 'PepsiCo',
        '052000': 'Gatorade (PepsiCo)',
        '078000': 'Keurig Dr Pepper / 7UP / Canada Dry',
        '071537': 'Polar Beverages',
        '71537': 'Polar Beverages',
        '073360': 'LaCroix Sparkling Water',
        '819215': 'Waterloo Sparkling Water',
        '081921': 'Waterloo Sparkling Water',
        '856416': 'Spindrift Sparkling Water',
        '810003': 'Liquid Death',
        '889392': 'Celsius Energy',
        '810169': 'GHOST Lifestyle / Energy',
        '070847': 'Monster Energy',
        '611269': 'Red Bull',
        '025000': 'Minute Maid / Simply Beverages',
        '048500': 'Tropicana',
        '031200': 'Ocean Spray',
        '041800': "Welch's",
        // Dairy, Plant Milks & Eggs
        '818290': 'Chobani',
        '036632': 'Danone / Dannon / Oikos / Silk',
        '025293': 'Silk / So Delicious (Danone)',
        '070470': 'Yoplait (General Mills)',
        '190646': 'Oatly',
        '852980': 'Califia Farms',
        '041570': 'Blue Diamond / Almond Breeze',
        '811620': 'Fairlife',
        '742365': 'Horizon Organic',
        '041383': 'Lactaid',
        '046100': 'Sargento Cheese',
        '072830': 'Tillamook Dairy',
        '078354': 'Cabot Creamery',
        '034500': "Land O'Lakes",
        '767707': 'Kerrygold',
        '073420': 'Daisy Brand',
        '858899': 'Vital Farms Pasture-Raised',
        '715141': "Eggland's Best",
        // Cereals, Grains, Snacks & Bakery
        '016000': 'General Mills',
        '16000': 'General Mills',
        '732153': 'Epic Provisions (General Mills)',
        '073215': 'Epic Provisions (General Mills)',
        '038000': "Kellogg's / WK Kellogg",
        '38000': "Kellogg's / WK Kellogg",
        '884912': 'Post Consumer Brands',
        '030000': 'Quaker Oats',
        '028400': 'Frito-Lay',
        '28400': 'Frito-Lay',
        '044000': 'Nabisco / Mondelēz',
        '44000': 'Nabisco / Mondelēz',
        '024100': 'Cheez-It / Keebler / Kellanova',
        '014100': 'Pepperidge Farm / Goldfish',
        '072250': "Flowers Foods (Nature's Own / Wonder / Dave's Killer Bread)",
        '72250': "Flowers Foods (Nature's Own / Wonder)",
        '013764': "Dave's Killer Bread",
        '048121': "Thomas' / Arnold / Oroweat / Entenmann's (Bimbo Bakeries)",
        '072945': 'Sara Lee / Bimbo Bakeries',
        '853608': 'Canyon Bakehouse Gluten-Free',
        '888109': 'Hostess Brands',
        '088810': 'Hostess Brands',
        '024300': 'Little Debbie (McKee Foods)',
        '039978': "Bob's Red Mill",
        '071012': 'King Arthur Baking Co.',
        '018000': 'Pillsbury / General Mills',
        '722252': 'Clif Bar',
        '857777': 'RXBAR',
        // Pantry, Pasta, Sauces, Soups & Condiments
        '051000': "Campbell's / Prego / Pace",
        '013000': 'Kraft Heinz',
        '021000': 'Kraft Foods',
        '076808': 'Barilla Pasta & Sauces',
        '747479': "Rao's Homemade",
        '024094': 'De Cecco Pasta',
        '036200': 'Ragu / Bertolli',
        '051500': "J.M. Smucker / Jif",
        '037600': 'Hormel Foods / Skippy / Planters',
        '052100': 'McCormick & Co.',
        '041500': "French's / Frank's RedHot (McCormick)",
        '048001': "Hellmann's / Best Foods / Knorr (Unilever)",
        '071100': 'Hidden Valley Ranch',
        '041335': "Ken's Steak House",
        '020662': "Newman's Own",
        '039400': "Bush's Best Beans",
        '041331': 'Goya Foods',
        '046000': 'Old El Paso',
        '073731': 'Mission Foods',
        '027000': "Conagra Brands (Hunt's / Healthy Choice / Marie Callender's / Bird's Eye)",
        '028000': "Nestlé / Stouffer's / DiGiorno",
        '034000': "Hershey's",
        '040000': 'Mars Wrigley / Ben\'s Original',
        '013562': "Annie's Homegrown",
        '042272': "Amy's Kitchen",
        // Meat, Deli, Produce & Infant Nutrition
        '023700': 'Tyson Foods / Jimmy Dean / Hillshire Farm',
        '044500': 'Hillshire Farm / Ball Park',
        '044700': 'Oscar Mayer',
        '070247': 'Smithfield Foods',
        '072745': 'Perdue Farms',
        '042421': "Boar's Head Provisions",
        '025317': 'Applegate Naturals',
        '042222': 'Butterball',
        '071430': 'Dole Fresh Vegetables & Salads',
        '071279': 'Fresh Express Salads',
        '032601': 'Earthbound Farm Organic',
        '732913': 'Taylor Farms',
        '078783': 'Grimmway Farms / Cal-Organic',
        '033383': 'Produce Marketing Association (Standard Fresh Produce)',
        '40822': 'Sabra Dipping Co.',
        '040822': 'Sabra Dipping Co.',
        '080000': 'StarKist Seafood',
        '086600': 'Bumble Bee Seafoods',
        '048000': 'Chicken of the Sea',
        '015000': 'Gerber Baby & Toddler Nutrition',
        '052200': 'Beech-Nut Baby Nutrition',
        '852697': 'Happy Baby Organics',
        '070074': 'Similac (Abbott Nutrition)',
        '30087': 'Enfamil (Reckitt / Mead Johnson)',
        '030087': 'Enfamil (Reckitt / Mead Johnson)'
      };

      for (const [prefix, mappedBrand] of Object.entries(GS1_DIRECTORY).sort((a, b) => b[0].length - a[0].length)) {
        if (cleanUpc.startsWith(prefix) || ('0' + cleanUpc).startsWith(prefix)) {
          return new Response(JSON.stringify({
            found: true,
            source: 'gs1_prefix',
            product: {
              upc: cleanUpc,
              name: `${mappedBrand} Packaged Food Item (${cleanUpc})`,
              brand: mappedBrand,
              ingredients: '',
              additives: [],
              allergens: []
            }
          }), { headers: corsHeaders });
        }
      }

      // Not found in any registry
      return new Response(JSON.stringify({
        found: false,
        upc: cleanUpc,
        message: 'Product not yet indexed in public food registries',
        diag: { off: [...new Set(offDiag)].slice(0, 6) }
      }), { status: 404, headers: corsHeaders });
    }

    // 4. POST /contribute: Community label indexing with Anti-Pollution Validation
    if (request.method === 'POST' && (url.pathname === '/contribute' || url.pathname === '/api/contribute')) {
      try {
        const body = await request.json();
        const cleanUpc = String(body.upc || '').replace(/\D/g, '');
        const productName = cleanText(body.name, 120);
        const brandName = cleanText(body.brand, 80);
        let ingredients = cleanText(body.ingredients, 3000);
        const rlContribAll = checkEdgeRateLimit(request, 'contribute');
        if (!rlContribAll.allowed) {
          return new Response(JSON.stringify({ error: 'Too many submissions. Please wait.', retryAfterSeconds: rlContribAll.retryAfterSec }), { status: 429, headers: { ...corsHeaders, ...rlContribAll.headers, 'Cache-Control': 'no-store' } });
        }
        const apiKey = resolveGeminiApiKey(env).key; // fixes ReferenceError that silently disabled OCR here
        const okMime = ['image/jpeg', 'image/png', 'image/webp'];
        const imgMime = okMime.includes(body.mimeType) ? body.mimeType : 'image/jpeg';

        // Optional: If an image was submitted, enforce per-IP OCR rate limit before calling Gemini 1.5 Flash
        if (body.imageBase64 && apiKey && String(body.imageBase64).length <= 6000000 && !ingredients) {
          { const aiBlocked = await aiGuard(env, request, corsHeaders); if (aiBlocked) return aiBlocked; }
      const rlContribute = checkEdgeRateLimit(request, 'contribute-ocr');
          if (!rlContribute.allowed) {
            return new Response(JSON.stringify({
              error: `OCR rate limit exceeded (${rlContribute.limit} requests/min). Please wait ${rlContribute.retryAfterSec}s before trying again.`,
              retryAfterSeconds: rlContribute.retryAfterSec
            }), { status: 429, headers: { ...corsHeaders, ...rlContribute.headers, 'Cache-Control': 'no-store' } });
          }
          try {
            const geminiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
              },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: 'Extract ONLY the raw printed ingredient list from this grocery packaging label. Return the exact comma-separated ingredients text without any intro or commentary.' },
                    { inline_data: { mime_type: imgMime, data: String(body.imageBase64).replace(/^data:image\/\w+;base64,/, '') } }
                  ]
                }]
              })
            });
            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              const extracted = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
              if (extracted && extracted.length > 5) {
                ingredients = cleanText(extracted, 3000);
              }
            }
          } catch (gErr) {
            console.warn('Gemini OCR fallback error:', gErr);
          }
        }

        // STRICT ANTI-POLLUTION QUALITY GATE:
        // Reject generic placeholders, empty names, or junk inputs
        if (!cleanUpc || cleanUpc.length < 6) {
          return new Response(JSON.stringify({ error: 'Valid barcode required' }), { status: 400, headers: corsHeaders });
        }
        if (!productName || productName.toLowerCase().startsWith('retail grocery item') || productName.length < 3) {
          return new Response(JSON.stringify({ error: 'Meaningful product name required' }), { status: 400, headers: corsHeaders });
        }

        const validFoodTokens = /\b(water|flour|sugar|salt|oil|syrup|yeast|milk|wheat|corn|soy|beef|chicken|pork|egg|eggs|butter|cream|vinegar|extract|juice|starch|protein|flavor|flavors|spice|spices|preservative|calcium|sodium|potassium|acid|gum|lecithin|dextrose|cocoa|oats|rice|cheese|tomato|potato|beans|cocoa)\b/i;
        if (ingredients && !validFoodTokens.test(ingredients)) {
          return new Response(JSON.stringify({ error: 'Ingredients must contain valid food components' }), { status: 400, headers: corsHeaders });
        }

        if (cleanUpc.length > 14) {
          return new Response(JSON.stringify({ error: 'Valid barcode required' }), { status: 400, headers: corsHeaders });
        }
        // Never overwrite an existing product (prevents catalog poisoning). Only fill in records that have no ingredients yet.
        if (env && env.RAKKA_COMMUNITY_DB) {
          const trimmed = cleanUpc.replace(/^0+/, '');
          const variants = [...new Set([cleanUpc, trimmed, trimmed.padStart(12, '0'), trimmed.padStart(13, '0')])];
          for (const v of variants) {
            let ex = null;
            try { ex = await env.RAKKA_COMMUNITY_DB.get(`upc:${v}`, { type: 'json' }); } catch (e) {}
            if (ex && ex.ingredients) {
              return new Response(JSON.stringify({ error: 'This barcode already has an entry. Report corrections through support.' }), { status: 409, headers: corsHeaders });
            }
          }
        }
        const record = {
          communitySubmitted: true,
          unverified: true,
          source: 'community',
          upc: cleanUpc,
          name: productName,
          brand: brandName || 'Grocery Brand',
          ingredients: ingredients || '',
          additives: [],
          allergens: [],
          verifiedAt: new Date().toISOString()
        };

        if (env && env.RAKKA_COMMUNITY_DB) {
          await env.RAKKA_COMMUNITY_DB.put(`upc:${cleanUpc}`, JSON.stringify(record));
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Product successfully indexed in community cache',
          product: record
        }), { status: 201, headers: corsHeaders });
      } catch (parseErr) {
        return new Response(JSON.stringify({ error: 'Invalid contribution payload' }), { status: 400, headers: corsHeaders });
      }
    }

    // 5. POST /detect-package: Multimodal AI Vision for whole-package photos
    if (request.method === 'POST' && (url.pathname === '/detect-package' || url.pathname === '/api/detect-package')) {
      { const aiBlocked = await aiGuard(env, request, corsHeaders); if (aiBlocked) return aiBlocked; }
      const rlPackage = checkEdgeRateLimit(request, 'detect-package');
      if (!rlPackage.allowed) {
        return new Response(JSON.stringify({
          found: false,
          error: `Rate limit reached (${rlPackage.limit} package scans/min). Please wait ${rlPackage.retryAfterSec}s before scanning again.`,
          retryAfterSeconds: rlPackage.retryAfterSec
        }), { status: 429, headers: { ...corsHeaders, ...rlPackage.headers, 'Cache-Control': 'no-store' } });
      }
      try {
        const body = await request.json();
        if (!body.imageBase64) {
          return new Response(JSON.stringify({ error: 'Image base64 data required' }), { status: 400, headers: corsHeaders });
        }

        const cleanBase64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = body.mimeType || 'image/jpeg';
        const apiKey = resolveGeminiApiKey(env, body).key;

        if (!apiKey) {
          return new Response(JSON.stringify({ 
            found: false, 
            error: 'AI Vision key not configured on edge hook. Configure GEMINI_API_KEY in Cloudflare Worker settings.' 
          }), { status: 503, headers: corsHeaders });
        }

        const prompt = `Analyze this grocery product package image with 1-shot food safety inspection.
Inspect the whole packaging including any barcodes, printed text, numbers, brand, ingredient list, and stamped expiration/lot dates.

Critical Safety Knowledge:
- If this is Grimmway Farms, Bunny Luv, Cal-Organic, or O Organics carrots: The FDA/CDC issued a major E. coli recall on whole and baby organic carrots.
- The affected recall window for Grimmway Farms organic baby carrots is Best-if-used-by dates between September 11, 2024 through November 12, 2024 (and historical lot batches).
- Inspect any ink stamp on the bag (e.g. BEST IF USED BY date or Julian lot code).

Extract and return STRICTLY a JSON object with this exact schema (no markdown, no backticks, raw JSON only):
{
  "upc": "12 or 13 digit barcode number if visible, otherwise null",
  "productName": "Exact product name and size (e.g. Organic Cut Baby Carrots, 1 lb)",
  "brand": "Exact brand name (e.g. Grimmway Farms)",
  "ingredients": "Raw comma-separated ingredients text if visible, or null",
  "lotCode": "Exact stamped expiration date or lot code found on the packaging (e.g. BEST IF USED BY 07 07 2016 159101BP2), or null",
  "lotAudit": {
    "hasRecallContext": true, // true if product brand/item has active or notable recall records
    "isMatch": true, // true if stamped date is within recall window, false if safe/outside window, null if date not visible
    "verdictTitle": "Short bold badge (e.g. 'CONFIRMED RECALL MATCH', 'CLEARED - OUTSIDE RECALL WINDOW', or 'RECALL ON RECORD - CHECK STAMP')",
    "explanation": "Clear 2-sentence explanation of whether this specific bag/lot is affected based on the stamped date.",
    "action": "Immediate directive for the consumer"
  }
}`;

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey || (env && env.GEMINI_API_KEY) || "")}`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: cleanBase64 } }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              response_mime_type: "application/json"
            }
          })
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          console.warn("Gemini Vision API error:", errText);
          return new Response(JSON.stringify({ found: false, error: 'AI vision inspection service busy' }), { status: 502, headers: corsHeaders });
        }

        const geminiData = await geminiRes.json();
        const rawJsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJsonText) {
          return new Response(JSON.stringify({ found: false, message: 'Could not detect product attributes from image' }), { headers: corsHeaders });
        }

        let parsed;
        try {
          parsed = JSON.parse(rawJsonText);
        } catch (jsonErr) {
          const match = rawJsonText.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
          else throw jsonErr;
        }

        const upc = String(parsed.upc || '').replace(/\D/g, '');
        const productName = parsed.productName || '';
        const brand = parsed.brand || '';
        const ingredients = parsed.ingredients || '';

        if (productName || upc) {
          const resolvedRecord = {
            upc: upc || 'VISION-DETECTED',
            name: productName,
            brand: brand || 'Grocery Brand',
            ingredients: ingredients || '',
            lotCode: parsed.lotCode || null,
            lotAudit: parsed.lotAudit || null,
            additives: [],
            allergens: []
          };

          // Cache in community DB if barcode and name exist
          if (upc && productName && env && env.RAKKA_COMMUNITY_DB) {
            ctx.waitUntil(env.RAKKA_COMMUNITY_DB.put(`upc:${upc}`, JSON.stringify(resolvedRecord), { metadata: { seen: Date.now() } }));
          }

          return new Response(JSON.stringify({
            found: true,
            source: 'gemini_vision_ai',
            product: resolvedRecord
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ found: false, message: 'No clear product or barcode found in image' }), { headers: corsHeaders });
      } catch (err) {
        console.error("Detect package exception:", err);
        return new Response(JSON.stringify({ found: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 6. POST /audit-lot-code: AI Lot & Best-By Date Auditor
    if (request.method === 'POST' && (url.pathname === '/audit-lot-code' || url.pathname === '/api/audit-lot-code')) {
      { const aiBlocked = await aiGuard(env, request, corsHeaders); if (aiBlocked) return aiBlocked; }
      const rlLot = checkEdgeRateLimit(request, 'audit-lot-code');
      if (!rlLot.allowed) {
        return new Response(JSON.stringify({
          success: false,
          error: `Lot auditor rate limit reached (${rlLot.limit} scans/min per IP). Please wait ${rlLot.retryAfterSec}s before scanning another stamp.`,
          retryAfterSeconds: rlLot.retryAfterSec
        }), { status: 429, headers: { ...corsHeaders, ...rlLot.headers, 'Cache-Control': 'no-store' } });
      }
      try {
        const body = await request.json();
        // Support either server-side Cloudflare secret OR client-provided key
        const apiKey = resolveGeminiApiKey(env, body).key;

        if (!apiKey) {
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'AI Vision key not configured on edge hook. Set GEMINI_API_KEY in Cloudflare Worker settings or in app Settings.' 
          }), { status: 503, headers: corsHeaders });
        }

        const cleanBase64 = String(body.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
        const mimeType = body.mimeType || 'image/jpeg';
        const recallTitle = body.recallTitle || 'Federal Public Health Recall';
        const recallReason = body.recallReason || '';
        const recallBrand = body.recallBrand || '';
        const expectedLots = body.expectedLots || '';

        const prompt = `You are an expert federal food safety inspector reviewing a customer's package photo for a food recall.
Recall Details:
- Food / Brand: ${recallBrand} - ${recallTitle}
- Hazard: ${recallReason}
- Known Affected Recall Window / Lots: ${expectedLots}

CRITICAL RULES FOR RECALL WINDOW & LOT VERIFICATION:
1. STRICT EVALUATION AGAINST THIS PRODUCT'S DEFINED RECALL CRITERIA:
   - Compare the package's stamped date and lot code strictly against this specific product's defined recall parameters: "${expectedLots}".
   - If the recall defines an affected date window (e.g., "between [Start Date] and [End Date]"):
     * If the stamped Best-By date falls ON or BETWEEN the start and end dates (or matches the affected lot code): The package is a direct match and RECALLED (isMatch: true, severity: "danger", verdictTitle: "DANGER - RECALLED BATCH").
     * If the stamped Best-By date is strictly AFTER the recall window end date (e.g., produced after the contaminated period ended or facility was sanitized): The package is CLEARED / OUTSIDE RECALL WINDOW (isMatch: false, severity: "safe", verdictTitle: "CLEARED - OUTSIDE RECALL WINDOW").
     * If the recall specifies "on or before [Date]" (or dates prior to a cutoff), any stamped date on or before that cutoff is RECALLED (isMatch: true, severity: "danger", verdictTitle: "DANGER - RECALLED BATCH").
   - If the stamped date or lot code directly matches the recalled batch parameters, you MUST mark isMatch: true and severity: "danger". Only mark as cleared (outside recall window) if the stamped date is verified to be outside/after the contaminated recall window.
2. STAMP READABILITY:
   - If the stamped date is completely illegible or cut off, set isMatch: null, severity: "warning", verdictTitle: "UNCLEAR STAMP".

Respond STRICTLY with a valid JSON object matching this schema (raw JSON only, no markdown, no backticks):
{
  "extractedCode": "Exact date/lot text found stamped on packaging, or 'Unclear' if illegible",
  "isMatch": false, // boolean: true ONLY if within recall dates/lots, false if outside recall window / safe, null if illegible
  "verdictTitle": "CLEARED - OUTSIDE RECALL WINDOW", // or 'CONFIRMED RECALL MATCH' or 'UNCLEAR STAMP'
  "severity": "safe", // 'safe' if cleared/outside window, 'danger' if confirmed match, 'warning' if unclear
  "explanation": "2-3 clear sentences explaining whether the stamped date falls inside or outside the stated federal recall window.",
  "action": "Stamped date falls outside the stated federal recall window (always verify physical packaging), or discard/return immediately if recalled."
}`;

        // Exact 1:1 Implementation Model of the Battle-Tested Receipt Scanner
        // Uses identical candidate hierarchy ('gemini-flash-latest'), payload structure, and discovery fallback
        const candidateModels = [
          'gemini-2.5-flash',
          'gemini-flash-latest'
        ];

        let geminiRes = null;
        let lastErrText = '';
        let successfulModel = '';
        const startTime = Date.now();

        for (const modelName of candidateModels) {
          try {
            // Speed Boost: Request thinkingBudget: 0 to bypass Google's 30-second reasoning token delay
            let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
              },
              signal: AbortSignal.timeout(30000),
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                  ]
                }],
                generationConfig: {
                  temperature: 0.1,
                  response_mime_type: "application/json",
                  thinkingConfig: { thinkingBudget: 0 }
                }
              })
            });

            // If the model rejects thinkingConfig (HTTP 400), gracefully fall back without it
            if (!res.ok && res.status === 400) {
              res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'x-goog-api-key': apiKey
                },
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({
                  contents: [{
                    parts: [
                      { text: prompt },
                      { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                    ]
                  }],
                  generationConfig: {
                    temperature: 0.1,
                    response_mime_type: "application/json"
                  }
                })
              });
            }

            if (res.ok) {
              geminiRes = res;
              successfulModel = modelName;
              break;
            } else {
              lastErrText = await res.text();
              console.warn(`Lot Audit Model ${modelName} returned HTTP ${res.status}:`, lastErrText);
            }
          } catch (modelErr) {
            console.warn(`Lot Audit Model ${modelName} fetch exception:`, modelErr);
          }
        }

        // Exact Receipt Scanner Fallback: Query Google's ModelService directly if static names fail
        if (!geminiRes || !geminiRes.ok) {
          try {
            const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
              headers: { 'x-goog-api-key': apiKey }
            });
            if (listRes.ok) {
              const listData = await listRes.json();
              const availableModels = (listData.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
              for (const m of availableModels) {
                const modelPath = m.name; // e.g. "models/gemini-..."
                const cleanModelName = modelPath.replace(/^models\//, '');
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                  },
                  body: JSON.stringify({
                    contents: [{
                      parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                      ]
                    }],
                    generationConfig: {
                      temperature: 0.1,
                      response_mime_type: "application/json"
                    }
                  })
                });
                if (res.ok) {
                  geminiRes = res;
                  successfulModel = cleanModelName;
                  break;
                }
              }
            }
          } catch (listErr) {
            console.warn('Dynamic model discovery error in lot audit:', listErr);
          }
        }

        if (!geminiRes || !geminiRes.ok) {
          let detailedErr = 'AI vision service busy';
          try {
            const errObj = JSON.parse(lastErrText);
            if (errObj && errObj.error && errObj.error.message) {
              detailedErr = errObj.error.message;
            }
          } catch (_) {}
          return new Response(JSON.stringify({ success: false, error: detailedErr }), { status: 502, headers: corsHeaders });
        }

        const geminiData = await geminiRes.json();
        const rawJsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let cleanJson = rawJsonText.trim();
        cleanJson = cleanJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        let parsed;
        try {
          parsed = JSON.parse(cleanJson);
        } catch (parseErr) {
          const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error(`Failed to parse AI vision lot audit output: ${parseErr.message}`);
          }
        }
        if (!parsed || typeof parsed !== 'object') {
          parsed = {
            extractedCode: "Unclear",
            isMatch: null,
            verdictTitle: "UNCLEAR STAMP",
            severity: "warning",
            explanation: "Could not definitively isolate date stamp text from photo.",
            action: "Compare printed date against recall window above."
          };
        }

        const latencyMs = Date.now() - startTime;
        return new Response(JSON.stringify({
          success: true,
          audit: parsed,
          modelUsed: successfulModel,
          latencyMs: latencyMs
        }), { headers: corsHeaders });
      } catch (err) {
        console.error("Audit lot code exception:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 7. POST /audit-receipt: AI Multi-Item Shopping Receipt Auditor
    if (request.method === 'POST' && (url.pathname === '/audit-receipt' || url.pathname === '/api/audit-receipt')) {
      { const aiBlocked = await aiGuard(env, request, corsHeaders); if (aiBlocked) return aiBlocked; }
      const rlReceipt = checkEdgeRateLimit(request, 'audit-receipt');
      if (!rlReceipt.allowed) {
        return new Response(JSON.stringify({
          success: false,
          error: `Receipt scanner rate limit reached (${rlReceipt.limit} requests/min per IP). Please wait ${rlReceipt.retryAfterSec}s before scanning another receipt.`,
          retryAfterSeconds: rlReceipt.retryAfterSec
        }), { status: 429, headers: { ...corsHeaders, ...rlReceipt.headers, 'Cache-Control': 'no-store' } });
      }
      try {
        const body = await request.json();
        const rq = await enforceReceiptQuota(env, request, body);
        if (!rq.ok) {
          return new Response(JSON.stringify({ success: false, error: rq.error, quotaExceeded: !!rq.quotaExceeded, plus: !!rq.plus }),
            { status: rq.status, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
        }
        // Support either server-side Cloudflare secret OR client-provided key
        const apiKey = resolveGeminiApiKey(env, body).key;

        if (!apiKey) {
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'AI Vision key not configured on edge hook. Set GEMINI_API_KEY in Cloudflare Worker settings or in app Settings.' 
          }), { status: 503, headers: corsHeaders });
        }

        const cleanBase64 = String(body.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
        const mimeType = body.mimeType || 'image/jpeg';
        const userAllergens = Array.isArray(body.activeAllergens) ? body.activeAllergens.join(', ') : 'None';

        const prompt = `You are an expert food safety auditor reviewing a grocery shopping receipt or shopping order audit (e.g. from ALDI, Walmart, Whole Foods, Kroger, Meijer, Giant Eagle, Trader Joe's, Costco, Target, Instacart, etc.).
User Household Allergen Safeguards to flag: ${userAllergens}

CRITICAL RECEIPT SOURCE & FORMAT INSTRUCTIONS:
1. The receipt image can be:
   - A physical thermal paper receipt photographed on a counter.
   - A digital e-receipt, mobile order confirmation, or store app screenshot.
   - A dark-mode screenshot, terminal output, or text simulation (e.g., white or cyan text on dark/black background).
   - A screenshot of a phone screen containing a receipt block inside chat or notes (ignore surrounding phone UI chrome like battery, time, chat headers like "Gemini", or input textboxes, and extract the grocery lines from the receipt block).
2. The receipt may be missing its top banner or store logo; identify the store from the private-label item nomenclature, prices, or store format (e.g., Great Value / BTRGDS = Walmart; 365 = Whole Foods; 6-digit codes = ALDI).
3. Extract ALL purchased food, beverage, produce, dairy, and grocery items shown strictly on the register tape:
   - RECEIPT TAPE BOUNDARIES (CRITICAL):
     * ONLY extract purchased lines that represent real grocery items with printed prices.
     * DO NOT extract items from instructional text boxes, testing cards, or notes labeled '[TESTING KEY — DO NOT SCAN AS RECEIPT]' or 'Expected RAKKA Outcome'.
     * DO NOT mistake register metadata, transaction barcodes (e.g. 'STORE #624', 'TRAN 3190', '*00624...*'), or store slogans like 'NEIGHBORHOOD GROCERY STORE' for grocery items!
     * Each purchased grocery item corresponds to exactly ONE line. NEVER duplicate items (e.g. do not emit two spinach items for a single receipt line).
     * BUT when the same product is printed on several separate lines (for example four identical 'Drinkable Yogurt' lines), return one entry for EACH printed line. Never merge separate printed lines.
     * The image may be one piece of a longer receipt and may start or end between lines; only extract complete lines you can see. A line with only a weight or price detail, such as '(N) 3.49 lb x 1.69/lb', belongs to the item above it and is not a new item.
   - Support common register line layouts and store formats:
     * Walmart: Register shorthand followed by 12-digit barcode and price (e.g., "NIGHT HAWK 004170901935 F 2.78", "HEALTHCHOICE 007265545445 F 2.98", "MANGO YOGURT 005360000026 F 0.50", "BANAN YOGURT 005360000030 F 0.50", "POTATOES 089286700194 F 2.94", "SUGAR GRANU 007874237117 F 4.98", "BULK LEMONS 000000004958KF 0.48").
     * Giant Eagle / Kroger / Meijer / Regional Grocers: Item description with price and tax flags (e.g., "GALILEO SALAME 2.99 F", "COLE SLAW 4.99 F", "PICNIC CHICKEN AC 9.99 F", "BE NATURAL MASHED 2.99 F", "TIC TAC ORANGE BOT 4.19 F").
     * ALDI / Trader Joe's / Costco: 6-digit item codes or direct descriptions.
   - Extract items even if prices are omitted, formatted in a separate column, or listed without dollar signs.
   - Extract items even if the UPC is listed on the same line.
   - Non-food merchandise filtering: Exclude non-food items (e.g. automotive motor oil 'AUTODRIVE', hardware/cookware 'DUTCH OVEN', 'REUSABLE BAGS USEDNP', 'TAX', 'BALANCE', cashier names), but NEVER omit real food, beverage, snack, meat, deli, produce, or candy items!
   - NEVER return an empty items list if food names appear on the receipt!
4. For each food item:
   - Expand truncated or abbreviated register item names into clear consumer product names (e.g., "Texas Toast" -> "L'Oven Fresh Texas Toast", "Pumpkin Loaf Cake" -> "Bake Shop Pumpkin Sliced Loaf Cake", "ChknAlfrdoMtblMar" -> "Chicken Alfredo / Meatball Marinara", "Polska Kielbasa" -> "Parkview Polska Kielbasa", "Hneycrsp Tote LRW" -> "Honeycrisp Apples", "Autumn Crisp Grape" -> "Autumn Crisp Green Seedless Grapes").
      - RECALLS: Do NOT judge whether a product is recalled. RAKKA checks the real FDA and USDA recall notices separately after you answer. Always set "status" to "clear", "warning" to "", "recallAgency" to null and "recallSeverity" to null.
   - Flag all common food allergens in this product (e.g. gluten, wheat, milk, dairy, soy, peanuts, tree_nuts, eggs, fish, shellfish, sesame, corn, sulfites, yeast).
   - CRITICAL ADDITIVE SCREENING: Identify all scrutinized food additives, preservatives, emulsifiers, synthetic dyes, or dough conditioners commonly used in this commercial formulation.
     Examples:
     * Commercial sliced bread / buns / texas toast: Calcium Propionate (preservative), DATEM, Monoglycerides, SSL (dough conditioners).
     * Processed meats (Kielbasa, Sausage, Pepperoni): Sodium Nitrite, Sodium Erythorbate, BHA/BHT, Sodium Phosphate.
     * Commercial baked goods / sweet loaf cakes / cookies: Artificial Flavors (Vanillin), High Fructose Corn Syrup, Polysorbate 60, Titanium Dioxide.
     * Confections & flavored snacks / chips / soda / energy drinks: Red 40, Yellow 5/6, Blue 1, Caramel Color, Sucralose, Acesulfame K, Citric Acid preservative.
     Return a clean array of additive names: ["Calcium Propionate", "DATEM"] (the client app enriches chemical descriptions locally).
5. CRITICAL RECEIPT BARCODE / ITEM CODE EXTRACTION:
   - For every item on the receipt, extract the exact printed barcode number, UPC, or store item code printed on the receipt line (e.g. 6-digit ALDI code like "398511" or "640511", or 8-to-12 digit standard UPC/SKU).
   - If identical products appear multiple times on the receipt (such as 3 cans of Poppi Prebiotic Soda), ensure that their printed itemCode and upc are IDENTICAL across all lines, matching the physical receipt tape.
   - Return this in the 'itemCode' field, and standard 12-digit UPC if known in the 'upc' field (otherwise matching itemCode).
6. Synthesize a concise 1-2 sentence safety summary.

Respond STRICTLY with a valid JSON object matching this schema (raw JSON only, no markdown, no backticks):
{
  "storeName": "Identified Store Name (e.g. ALDI, Kroger, Meijer) or 'Grocery Store'",
  "purchaseDate": "Date on receipt or 'Today'",
  "totalFoodItems": 12,
  "recalledCount": 0,
  "allergenWarningCount": 1,
  "items": [
    {
      "rawLine": "Raw line from receipt slip",
      "cleanName": "Standardized Food Name",
      "brand": "Brand or Store Brand",
      "itemCode": "Receipt barcode or store item code printed on receipt line (e.g. '398511', '640511', or '08500248231')",
      "upc": "Receipt barcode, item code, or standard 12-digit UPC",
      "status": "clear", // 'clear', 'recalled', or 'allergen_alert'
      "recallAgency": "FDA", // 'FDA' or 'USDA-FSIS' if recalled, otherwise null
      "recallSeverity": "Class I High Risk", // 'Class I High Risk' if recalled, otherwise null
      "warning": "Brief warning explanation if recalled or allergen alert, otherwise null",
      "allergens": ["gluten", "dairy", "soy"], // list of common allergen ids
      "additives": ["Calcium Propionate", "DATEM"] // compact array of chemical names (client auto-enriches full health descriptions)
    }
  ],
  "auditSummary": "1-2 sentence executive safety summary"
}`;

        // Multi-Model Fallback: Try current Gemini 2.0/2.5 Flash, followed by latest Flash revisions
                // Multi-Model Fallback: Try current Gemini 2.0/2.5 Flash, followed by latest Flash revisions
        // If static names fail, dynamically discover which model this key is permitted to call!
        const candidateModels = [
          'gemini-flash-latest',
          'gemini-1.5-flash',
          'gemini-2.5-flash'
        ];

        let geminiRes = null;
        let lastErrText = '';

        for (const modelName of candidateModels) {
          try {
            // Speed Boost: Request thinkingBudget: 0 to bypass Google's 30-second reasoning token delay
            let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
              },
              signal: AbortSignal.timeout(30000),
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                  ]
                }],
                generationConfig: {
                  temperature: 0.1,
                  response_mime_type: "application/json",
                  thinkingConfig: { thinkingBudget: 0 }
                }
              })
            });

            // If the model rejects thinkingConfig (HTTP 400), gracefully fall back without it
            if (!res.ok && res.status === 400) {
              res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'x-goog-api-key': apiKey
                },
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({
                  contents: [{
                    parts: [
                      { text: prompt },
                      { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                    ]
                  }],
                  generationConfig: {
                    temperature: 0.1,
                    response_mime_type: "application/json"
                  }
                })
              });
            }

            if (res.ok) {
              geminiRes = res;
              break;
            } else {
              lastErrText = await res.text();
              console.warn(`Model ${modelName} returned HTTP ${res.status}:`, lastErrText);
            }
          } catch (modelErr) {
            console.warn(`Model ${modelName} fetch exception:`, modelErr);
          }
        }

        // If candidate list failed, query Google's ModelService directly for all models permitted on this key!
        if (!geminiRes || !geminiRes.ok) {
          try {
            const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
              headers: { 'x-goog-api-key': apiKey }
            });
            if (listRes.ok) {
              const listData = await listRes.json();
              const availableModels = (listData.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
              for (const m of availableModels) {
                const modelPath = m.name; // e.g. "models/gemini-..."
                const cleanModelName = modelPath.replace(/^models\//, '');
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                  },
                  body: JSON.stringify({
                    contents: [{
                      parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                      ]
                    }],
                    generationConfig: {
                      temperature: 0.1,
                      response_mime_type: "application/json"
                    }
                  })
                });
                if (res.ok) {
                  geminiRes = res;
                  break;
                }
              }
            }
          } catch (listErr) {
            console.warn('Dynamic model discovery error:', listErr);
          }
        }

        if (!geminiRes || !geminiRes.ok) {
          let detailedErr = 'Receipt vision service busy';
          try {
            const errObj = JSON.parse(lastErrText);
            if (errObj && errObj.error && errObj.error.message) {
              detailedErr = errObj.error.message;
            }
          } catch (_) {}
          return new Response(JSON.stringify({ success: false, error: detailedErr }), { status: 502, headers: corsHeaders });
        }

        const geminiData = await geminiRes.json();
        const rawJsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let cleanJson = rawJsonText.trim();
        cleanJson = cleanJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        let parsed;
        try {
          parsed = JSON.parse(cleanJson);
        } catch (parseErr) {
          const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error(`Failed to parse AI vision receipt output: ${parseErr.message}`);
          }
        }
        if (!parsed || typeof parsed !== 'object') {
          parsed = { items: [], totalFoodItems: 0, storeName: 'Grocery Store' };
        }
        if (!Array.isArray(parsed.items)) {
          parsed.items = [];
        }

        // Recall flags come only from the real FDA / USDA notices (same matcher as the barcode check), never from the AI's guess.
        let recallsChecked = false, recalledTotal = 0;
        try {
          const feed = await alLoadFeedMemo(env);
          const index = alIndexFor(feed);
          recallsChecked = !!(feed.fdaOk || feed.usdaOk);
          const order = { exact: 0, near: 1, possible: 2 };
          for (const it of parsed.items) {
            if (!it || typeof it !== 'object') continue;
            it.status = 'clear'; it.isRecalled = false; it.warning = ''; it.recallAgency = null; it.recallSeverity = null;
            const hit = alReceiptMatch(index, { u: String(it.upc || it.itemCode || (String(it.rawLine || '').match(/\b\d{8,14}\b/) || [''])[0] || ''), n: String(it.cleanName || it.rawLine || ''), b: String(it.brand || '') });
            const best = hit;
            if (best) {
              recalledTotal++;
              it.status = 'recalled'; it.isRecalled = true; it.recallVerified = true;
              it.warning = `${best.r.agency} recall: ${best.r.reason || best.r.product}${best.m.confidence === 'exact' ? '' : ' (' + best.m.why + ')'}`.slice(0, 400);
              it.recallAgency = best.r.agency === 'USDA FSIS' ? 'USDA-FSIS' : 'FDA';
              it.recallSeverity = best.m.confidence === 'exact' ? (best.r.classification || 'Recall') : 'Possible match: check the package';
              it.recallRef = best.r.id;
            }
          }
        } catch (_) { /* recall check unavailable: items stay unflagged, and the app's own recall list still runs */ }
        parsed.recalledCount = recalledTotal;
        parsed.recallsChecked = recallsChecked;

        return new Response(JSON.stringify({
          success: true,
          receipt: parsed
        }), { headers: corsHeaders });
      } catch (err) {
        console.error("Audit receipt exception:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 7a. BACKGROUND RECALL ALERTS + DELETE MY DATA
    if (request.method === 'POST' && (url.pathname.startsWith('/alerts/') || url.pathname === '/data/delete')) {
      const rlAlerts = checkEdgeRateLimit(request, 'alerts');
      if (!rlAlerts.allowed) {
        return new Response(JSON.stringify({ success: false, error: `Too many requests. Please wait ${rlAlerts.retryAfterSec}s.` }),
          { status: 429, headers: { ...corsHeaders, ...rlAlerts.headers, 'Cache-Control': 'no-store' } });
      }
      const alertsResponse = await alHandleRequest(request, env, url, corsHeaders, ctx);
      if (alertsResponse) return alertsResponse;
    }

    // 7b. RAKKA PLUS ENTITLEMENT (invite codes + one-time trial; tokens are signed by this Worker)
    if (request.method === 'POST' && url.pathname.startsWith('/plus/')) {
      const rlPlus = checkEdgeRateLimit(request, 'plus');
      const plusHeaders = { ...corsHeaders, 'Cache-Control': 'no-store' };
      const plusReply = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...plusHeaders, ...extra } });
      if (!rlPlus.allowed) return plusReply({ success: false, error: `Too many attempts. Please wait ${rlPlus.retryAfterSec}s.` }, 429, rlPlus.headers);
      if (!env || !env.RAKKA_COMMUNITY_DB) return plusReply({ success: false, error: 'Storage is not bound to this Worker.' }, 503);
      if (!(await plusHmacKey(env))) return plusReply({ success: false, error: 'Plus is not configured on the server yet.' }, 503);
      let pb = {};
      try { pb = await request.json(); } catch (_) {}
      const pDevice = String(pb.deviceId || '').trim().slice(0, 80);
      if (!pDevice) return plusReply({ success: false, error: 'deviceId required' }, 400);

      if (url.pathname === '/plus/redeem') {
        const code = String(pb.code || '').trim().toUpperCase().slice(0, 64);
        const max = parsePlusCodes(env).get(code);
        if (!max) return plusReply({ success: false, error: 'That code is not valid.' }, 403);
        const devKey = `plusdev:${code}`;
        const devs = (await env.RAKKA_COMMUNITY_DB.get(devKey, { type: 'json' })) || [];
        if (!devs.includes(pDevice)) {
          if (devs.length >= max) return plusReply({ success: false, error: 'That code has already been used on the maximum number of devices.' }, 403);
          devs.push(pDevice);
          await env.RAKKA_COMMUNITY_DB.put(devKey, JSON.stringify(devs));
        }
        const exp = Date.now() + PLUS_TOKEN_DAYS * 86400000;
        const token = await signPlusToken(env, { d: pDevice, k: 'code', c: code, exp });
        return plusReply({ success: true, active: true, kind: 'code', exp, token });
      }

      if (url.pathname === '/plus/trial') {
        const tKey = `plustrial:${pDevice}`;
        if (await env.RAKKA_COMMUNITY_DB.get(tKey)) return plusReply({ success: false, error: 'The free trial has already been used on this device.' }, 403);
        const exp = Date.now() + PLUS_TRIAL_DAYS * 86400000;
        await env.RAKKA_COMMUNITY_DB.put(tKey, String(Date.now()));
        const token = await signPlusToken(env, { d: pDevice, k: 'trial', exp });
        return plusReply({ success: true, active: true, kind: 'trial', exp, token });
      }

      if (url.pathname === '/plus/status') {
        const p = await checkPlus(env, pb.token, pDevice);
        if (!p) return plusReply({ success: true, active: false });
        if (p.k === 'code') {
          const exp = Date.now() + PLUS_TOKEN_DAYS * 86400000;
          const token = await signPlusToken(env, { d: pDevice, k: 'code', c: p.c, exp });
          return plusReply({ success: true, active: true, kind: 'code', exp, token });
        }
        return plusReply({ success: true, active: true, kind: 'trial', exp: p.exp, token: pb.token });
      }
      return plusReply({ success: false, error: 'Unknown Plus endpoint' }, 404);
    }

    // 8. 2-PERSON HOUSEHOLD SYNC (Plus Tier - Max 2 Devices - Zero PII)
    if (request.method === 'POST' && url.pathname.startsWith('/household/')) {
      const rlHh = checkEdgeRateLimit(request, 'household');
      if (!rlHh.allowed) {
        return new Response(JSON.stringify({
          success: false,
          error: `Sync rate limit reached. Please wait ${rlHh.retryAfterSec}s.`
        }), { status: 429, headers: { ...corsHeaders, ...rlHh.headers, 'Cache-Control': 'no-store' } });
      }
      if (!env || !env.RAKKA_COMMUNITY_DB) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cloudflare KV (RAKKA_COMMUNITY_DB) is not bound to this Worker.'
        }), { status: 503, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
      }

      const noCacheHeaders = { ...corsHeaders, 'Cache-Control': 'no-store' };
      const generateInviteCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        let code = '';
        for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
        return `RKA-${code.slice(0, 3)}-${code.slice(3)}`;
      };

      const mergeProfiles = (a = [], b = []) => {
        const map = new Map();
        [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(p => {
          if (!p || !p.id) return;
          const prev = map.get(p.id);
          if (!prev) {
            map.set(p.id, { ...p, allergens: Array.isArray(p.allergens) ? [...new Set(p.allergens)] : [] });
          } else {
            const mergedAllergens = [...new Set([...(prev.allergens || []), ...(p.allergens || [])])];
            map.set(p.id, { ...prev, ...p, allergens: mergedAllergens });
          }
        });
        return [...map.values()].slice(0, 8);
      };

      const mergeHistory = (a = [], b = []) => {
        const map = new Map();
        [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(item => {
          if (!item) return;
          const k = item.id || `${item.upc || item.title || 'item'}|${item.receiptGroup || ''}`;
          const prev = map.get(k);
          if (!prev || (item.scannedDate || 0) >= (prev.scannedDate || 0)) {
            map.set(k, item);
          }
        });
        return [...map.values()].slice(0, 500);
      };

      // Household sync is end-to-end encrypted by the phones. The worker only stores an opaque blob it cannot read.
      const cleanBlob = (v) => (typeof v === 'string' && v.length <= 700000 && /^[A-Za-z0-9_-]*$/.test(v)) ? v : null;

      try {
        const body = await request.json();
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!deviceId) {
          return new Response(JSON.stringify({ success: false, error: 'deviceId required' }), { status: 400, headers: noCacheHeaders });
        }

        // POST /household/create
        if (url.pathname === '/household/create') {
          const existingId = String(body.householdId || '').trim();
          const inviteCode = generateInviteCode();
          const now = Date.now();
          // Only a device with a valid Plus entitlement can host a household.
          const hostPlus = await checkPlus(env, body.plusToken, deviceId);
          if (!hostPlus) {
            return new Response(JSON.stringify({ success: false, error: 'RAKKA Plus is required to host a household.' }), { status: 403, headers: noCacheHeaders });
          }

          if (existingId) {
            const existingHh = await env.RAKKA_COMMUNITY_DB.get(`hh:${existingId}`, { type: 'json' });
            if (existingHh && Array.isArray(existingHh.members) && existingHh.members.includes(deviceId)) {
              if (existingHh.members.length >= 2) {
                return new Response(JSON.stringify({ success: false, error: 'This household already has 2 linked devices.' }), { status: 403, headers: noCacheHeaders });
              }
              existingHh.plusUntil = hostPlus.exp;
              delete existingHh.plusActive;
              await env.RAKKA_COMMUNITY_DB.put(`hh:${existingId}`, JSON.stringify(existingHh), { expirationTtl: HH_TTL_SECONDS });
              await env.RAKKA_COMMUNITY_DB.put(`hhcode:${inviteCode}`, JSON.stringify({ householdId: existingId, createdBy: deviceId }), { expirationTtl: 86400 });
              return new Response(JSON.stringify({
                success: true,
                householdId: existingId,
                inviteCode,
                memberCount: existingHh.members.length,
                maxMembers: 2,
                updatedAt: existingHh.updatedAt || now
              }), { headers: noCacheHeaders });
            }
          }

          const householdId = crypto.randomUUID();
          const hhRecord = {
            householdId,
            members: [deviceId],
            plusUntil: hostPlus.exp,
            updatedAt: now,
            blob: cleanBlob(body.blob) || ''
          };
          await env.RAKKA_COMMUNITY_DB.put(`hh:${householdId}`, JSON.stringify(hhRecord), { expirationTtl: HH_TTL_SECONDS });
          await env.RAKKA_COMMUNITY_DB.put(`hhcode:${inviteCode}`, JSON.stringify({ householdId, createdBy: deviceId }), { expirationTtl: 86400 });
          return new Response(JSON.stringify({
            success: true,
            householdId,
            inviteCode,
            memberCount: 1,
            maxMembers: 2,
            updatedAt: now
          }), { headers: noCacheHeaders });
        }

        // POST /household/join
        if (url.pathname === '/household/join') {
          const rawCode = String(body.inviteCode || '').trim().toUpperCase();
          const rlJoin = checkEdgeRateLimit(request, 'household-join');
          if (!rlJoin.allowed) {
            return new Response(JSON.stringify({ success: false, error: 'Too many attempts. Please wait a minute.' }), { status: 429, headers: { ...noCacheHeaders, ...rlJoin.headers } });
          }
          if (!/^RKA-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(rawCode)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid or expired invite code.' }), { status: 404, headers: noCacheHeaders });
          }
          if (!rawCode) {
            return new Response(JSON.stringify({ success: false, error: 'Invite code required' }), { status: 400, headers: noCacheHeaders });
          }
          const codeData = await env.RAKKA_COMMUNITY_DB.get(`hhcode:${rawCode}`, { type: 'json' });
          if (!codeData || !codeData.householdId) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid or expired invite code.' }), { status: 404, headers: noCacheHeaders });
          }
          const hh = await env.RAKKA_COMMUNITY_DB.get(`hh:${codeData.householdId}`, { type: 'json' });
          if (!hh) {
            return new Response(JSON.stringify({ success: false, error: 'Household record not found.' }), { status: 404, headers: noCacheHeaders });
          }
          const members = Array.isArray(hh.members) ? hh.members : [];
          if (!members.includes(deviceId) && members.length >= 2) {
            return new Response(JSON.stringify({ success: false, error: 'This household already has 2 linked devices.' }), { status: 403, headers: noCacheHeaders });
          }
          if (!members.includes(deviceId)) members.push(deviceId);
          hh.members = members;
          // Remove any plaintext profiles/scans left over from the older, unencrypted sync.
          delete hh.familyProfiles;
          delete hh.scanHistory;
          hh.updatedAt = Date.now();
          await env.RAKKA_COMMUNITY_DB.put(`hh:${hh.householdId}`, JSON.stringify(hh), { expirationTtl: HH_TTL_SECONDS });

          return new Response(JSON.stringify({
            success: true,
            householdId: hh.householdId,
            plusActive: Boolean(hh.plusUntil && hh.plusUntil > Date.now()),
            plusUntil: hh.plusUntil || 0,
            memberCount: hh.members.length,
            updatedAt: hh.updatedAt,
            blob: hh.blob || ''
          }), { headers: noCacheHeaders });
        }

        // POST /household/sync
        if (url.pathname === '/household/sync') {
          const householdId = String(body.householdId || '').trim();
          if (!householdId) {
            return new Response(JSON.stringify({ success: false, error: 'householdId required' }), { status: 400, headers: noCacheHeaders });
          }
          const hh = await env.RAKKA_COMMUNITY_DB.get(`hh:${householdId}`, { type: 'json' });
          if (!hh) {
            return new Response(JSON.stringify({ success: false, error: 'Household not found or unlinked.' }), { status: 404, headers: noCacheHeaders });
          }
          const members = Array.isArray(hh.members) ? hh.members : [];
          if (!members.includes(deviceId)) {
            return new Response(JSON.stringify({ success: false, error: 'Device is not linked to this household.' }), { status: 403, headers: noCacheHeaders });
          }

          const action = body.action === 'push' ? 'push' : 'pull';
          if (action === 'push') {
            const baseTs = Number(body.baseUpdatedAt || 0);
            const isStale = baseTs > 0 && (hh.updatedAt || 0) > baseTs;
            const newBlob = cleanBlob(body.blob);
            if (newBlob !== null && body.blob !== undefined) {
              if (isStale) {
                // The other phone changed things first. The server cannot merge encrypted data, so the app merges and retries.
                return new Response(JSON.stringify({ success: false, conflict: true, error: 'Household changed on another device.', updatedAt: hh.updatedAt, blob: hh.blob || '' }), { status: 409, headers: noCacheHeaders });
              }
              hh.blob = newBlob;
            }
            delete hh.familyProfiles;
            delete hh.scanHistory;
            const pushPlus = await checkPlus(env, body.plusToken, deviceId);
            if (pushPlus) hh.plusUntil = pushPlus.exp;
            hh.updatedAt = Date.now();
            await env.RAKKA_COMMUNITY_DB.put(`hh:${householdId}`, JSON.stringify(hh), { expirationTtl: HH_TTL_SECONDS });
          }

          return new Response(JSON.stringify({
            success: true,
            householdId: hh.householdId,
            plusActive: Boolean(hh.plusUntil && hh.plusUntil > Date.now()),
            plusUntil: hh.plusUntil || 0,
            memberCount: members.length,
            updatedAt: hh.updatedAt || Date.now(),
            blob: hh.blob || ''
          }), { headers: noCacheHeaders });
        }

        // POST /household/leave
        if (url.pathname === '/household/leave') {
          const householdId = String(body.householdId || '').trim();
          if (householdId) {
            const hh = await env.RAKKA_COMMUNITY_DB.get(`hh:${householdId}`, { type: 'json' });
            if (hh && Array.isArray(hh.members)) {
              hh.members = hh.members.filter(m => m !== deviceId);
              if (hh.members.length === 0) {
                await env.RAKKA_COMMUNITY_DB.delete(`hh:${householdId}`);
              } else {
                hh.updatedAt = Date.now();
                await env.RAKKA_COMMUNITY_DB.put(`hh:${householdId}`, JSON.stringify(hh), { expirationTtl: HH_TTL_SECONDS });
              }
            }
          }
          return new Response(JSON.stringify({ success: true }), { headers: noCacheHeaders });
        }
      } catch (hhErr) {
        return new Response(JSON.stringify({ success: false, error: hhErr.message }), { status: 400, headers: noCacheHeaders });
      }
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: corsHeaders });
  },

  // Cloudflare Cron Trigger: checks watchlists against new recalls (see SETUP-ALERTS.md).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(alRunScheduled(env));
  }
};
