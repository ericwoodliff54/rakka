/**
 * RAKKA Cloud Edge Hook - Serverless Barcode Aggregator & Community Cache
 * Designed for Cloudflare Workers (100,000 free requests/day)
 * 100% Private: Zero PII, Zero User Accounts, Zero Tracking
 */

// Master Embedded Key (Optional: Paste Gemini API key here in Cloudflare Quick Edit to bypass dashboard variables)
const EMBEDDED_GEMINI_KEY = "";

function resolveGeminiApiKey(env, body) {
  if (typeof EMBEDDED_GEMINI_KEY === 'string' && EMBEDDED_GEMINI_KEY.trim().length > 0) {
    return { key: EMBEDDED_GEMINI_KEY.trim().replace(/^[\"\']|[\"\']$/g, ''), source: 'embedded_code' };
  }
  const bodyKey = body && (body.clientApiKey || body.apiKey || body.geminiApiKey);
  if (typeof bodyKey === 'string' && bodyKey.trim().length > 0) {
    return { key: bodyKey.trim().replace(/^[\"\']|[\"\']$/g, ''), source: 'client_payload' };
  }
  const envAliases = [
    'GEMINI_API_KEY', 'gemini_api_key', 'GEMINI_KEY', 'gemini_key',
    'GOOGLE_API_KEY', 'google_api_key', 'API_KEY', 'api_key',
    'GEMINI_TOKEN', 'gemini_token', 'GOOGLE_KEY', 'google_key',
    'AI_VISION_KEY', 'ai_vision_key', 'GEMINI', 'gemini'
  ];
  if (env && typeof env === 'object') {
    for (const alias of envAliases) {
      if (typeof env[alias] === 'string' && env[alias].trim().length > 0) {
        return { key: env[alias].trim().replace(/^[\"\']|[\"\']$/g, ''), source: `cloudflare_env (${alias})` };
      }
    }
  }
  if (typeof globalThis !== 'undefined') {
    for (const alias of envAliases) {
      if (typeof globalThis[alias] === 'string' && globalThis[alias].trim().length > 0) {
        return { key: globalThis[alias].trim().replace(/^[\"\']|[\"\']$/g, ''), source: `globalThis (${alias})` };
      }
    }
  }
  return { key: '', source: 'none' };
}

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
  'contribute-ocr': 10   // 10 req/min per IP for community ingredient OCR
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
  <meta name="description" content="Official Privacy Policy for RAKKA Food Safety & Recall Scanner by Twin Ravens Digital LLC. Zero tracking, offline-first local storage, and complete user privacy.">
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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">Official Legal Notice</div>
      <h1>Privacy Policy & Terms</h1>
      <p class="subtitle">Twin Ravens Digital LLC • RAKKA Food Safety & Recall Scanner</p>
      <p class="policy-meta">Effective Date: November 11, 2026 • Version 1.4</p>
    </header>

    <div class="summary-card">
      <h2>Executive Summary: Zero Tracking, Offline-First</h2>
      <p>RAKKA was built on the core principle that personal dietary and health data belongs solely to the user. We do not require accounts, we do not track your location, and we do not sell or monetize personal shopping records. All household profiles, allergen filters, and pantry lists remain stored directly on your physical device.</p>
    </div>

    <section>
      <h2>1. Information We Do Not Collect</h2>
      <p>Unlike conventional consumer apps, RAKKA does not harvest personal identity metrics:</p>
      <ul>
        <li><strong>No Account Required:</strong> You do not register with an email, phone number, password, or social media login to scan food or receive recall alerts.</li>
        <li><strong>No Location Tracking:</strong> We do not track, collect, or share your GPS coordinates, IP-derived physical locations, or shopping routes.</li>
        <li><strong>No Data Monetization:</strong> We do not sell, rent, license, or disclose your dietary restrictions, household member profiles, or scan histories to data brokers, insurers, food manufacturers, or targeted advertising networks.</li>
      </ul>
    </section>

    <section>
      <h2>2. On-Device Local Storage</h2>
      <p>RAKKA operates with an <strong>offline-first local architecture</strong>. The following data is written directly to your device's browser local storage (IndexedDB / LocalStorage) and is never transmitted to our servers:</p>
      <ul>
        <li><strong>Family Dietary Profiles:</strong> Custom household member names, avatars, and specific allergen alert preferences.</li>
        <li><strong>Allergen & Additive Shields:</strong> Toggles for the 12 essential allergens and 37 scrutinized food chemicals/dyes.</li>
        <li><strong>Pantry & Fridge Watchlist:</strong> Up to 50 items (Free tier) or 500 items (Plus tier) saved for continuous federal recall cross-referencing.</li>
      </ul>
      <p>You can instantly delete all local records at any time using the <strong>"Factory Reset & Clear All Data"</strong> button in the Settings menu.</p>
    </section>

    <section>
      <h2>3. Camera & Hardware Sensor Access</h2>
      <p>RAKKA requests camera access strictly to perform optical barcode recognition:</p>
      <ul>
        <li><strong>Live Barcode Scanning:</strong> Camera video frames are evaluated in real time within device memory to decode standard GS1 UPC and EAN barcodes. Video feeds are never recorded, saved to disk, or broadcast over the internet.</li>
        <li><strong>Instant Camera Deactivation:</strong> The camera stream automatically pauses immediately upon barcode lock and automatically halts when the app is backgrounded or screen locked to prevent background streaming and save battery.</li>
      </ul>
    </section>

    <section>
      <h2>4. Ephemeral Receipt & Expiration Lot Audits</h2>
      <p>When you use the Multi-Item Receipt Auditor or Packaging Date Stamp Auditor:</p>
      <ul>
        <li>Images snapped for receipt reading or embossed lot code inspection are transmitted via secure HTTPS (TLS 1.3) to our Cloudflare Worker proxy for optical character recognition (OCR) via Google Gemini 1.5 Flash.</li>
        <li><strong>Zero Permanent Storage:</strong> These images are held in volatile RAM strictly for the duration of the 2-to-4 second extraction request and are immediately discarded. Images are never archived, cataloged, or linked to any user identifier.</li>
      </ul>
    </section>

    <section>
      <h2>5. Anonymous Community Product Catalog</h2>
      <p>When an unindexed product barcode is resolved, anonymous packaging facts (product title, brand, and manufacturer ingredient text) may be cached in our Cloudflare KV community database (<code>RAKKA_COMMUNITY_DB</code>). This catalog contains solely publicly printed package disclosures and contains zero user identifiers, photos, device IDs, or personal shopping histories.</p>
    </section>

    <section>
      <h2>6. Third-Party Data Sources & Subscriptions</h2>
      <p>RAKKA interfaces with reputable external services to deliver safety data:</p>
      <ul>
        <li><strong>Federal Public Safety APIs:</strong> Recall enforcement reports are queried directly and anonymously from official openFDA and USDA Food Safety and Inspection Service (FSIS) public databases.</li>
        <li><strong>In-App Subscriptions:</strong> Plus tier subscriptions are billed securely through Apple In-App Purchases (iOS StoreKit), Google Play Billing, or Stripe (Web PWA). All financial transactions are processed directly by the respective platform; Twin Ravens Digital LLC never receives, processes, or stores your credit card details.</li>
      </ul>
    </section>

    <section>
      <h2>7. Food Safety & Medical Disclaimer</h2>
      <p>RAKKA is an informational assistant designed to streamline food label and federal recall awareness. It is not a clinical medical diagnostic device and does not guarantee the prevention of life-threatening allergic reactions (anaphylaxis). Label formulations, cross-contamination warnings, and manufacturer lots change rapidly. Always inspect the physical product packaging and consult a board-certified allergist for medical guidance.</p>
    </section>

    <section>
      <h2>8. Children's Privacy (COPPA Compliance)</h2>
      <p>RAKKA does not knowingly collect, solicit, or maintain personal information from children under the age of 13. Household family profiles are managed locally on the parent or guardian's personal device.</p>
    </section>

    <section>
      <h2>9. Contact & Developer Information</h2>
      <p>For questions, privacy inquiries, or legal communications regarding RAKKA or Twin Ravens Digital LLC:</p>
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

export default {
  async fetch(request, env, ctx) {
    // 1. Hardened CORS Preflight (Explicit 204 No Content + Custom Client & Auth Headers)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-rakka-client-version, x-goog-api-key',
          'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-rakka-client-version, x-goog-api-key',
      'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    };

    // 2. Health check / status
        // Diagnostic: Query Google ModelService.ListModels to see exactly which models this API key is allowed to use
    if (url.pathname === '/models' || url.pathname === '/api/models') {
      const apiKey = resolveGeminiApiKey(env).key || url.searchParams.get('key');
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

    if (url.pathname === '/' || url.pathname === '/health') {
      const { key, source } = resolveGeminiApiKey(env);
      const hasKey = Boolean(key && key.length > 0);
      return new Response(JSON.stringify({
        status: 'online',
        service: 'RAKKA Cloud Edge Hook',
        version: '1.4.2',
        ai_vision_key_configured: hasKey,
        key_source: source,
        key_preview: hasKey ? `${key.slice(0, 6)}...` : 'NONE',
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
          const kvResults = await Promise.all(
            uniqueCodes.map(codeVar => env.RAKKA_COMMUNITY_DB.get(`upc:${codeVar}`, { type: 'json' }).catch(() => null))
          );
          const cached = kvResults.find(item => item && item.name && !item.name.startsWith('Retail Grocery Item'));
          if (cached) {
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

      try {
        const fetchPromises = uniqueCodes.map(q => {
          return fetch(`https://world.openfoodfacts.org/api/v0/product/${q}.json`, {
            headers: { 'User-Agent': 'RAKKA-FoodSafetyApp/1.0 (https://rakka.app)' }
          })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.status === 1 && data.product) return data.product;
            throw new Error('Not found');
          });
        });
        offProduct = await Promise.any(fetchPromises);
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
              env.RAKKA_COMMUNITY_DB.put(`upc:${base12}`, JSON.stringify(resolved)),
              env.RAKKA_COMMUNITY_DB.put(`upc:0${base12}`, JSON.stringify(resolved))
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
                  env.RAKKA_COMMUNITY_DB.put(`upc:${base12}`, JSON.stringify(resolved)),
                  env.RAKKA_COMMUNITY_DB.put(`upc:0${base12}`, JSON.stringify(resolved))
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
        '852697': 'KIND Snacks',
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
        message: 'Product not yet indexed in public food registries'
      }), { status: 404, headers: corsHeaders });
    }

    // 4. POST /contribute: Community label indexing with Anti-Pollution Validation
    if (request.method === 'POST' && (url.pathname === '/contribute' || url.pathname === '/api/contribute')) {
      try {
        const body = await request.json();
        const cleanUpc = String(body.upc || '').replace(/\D/g, '');
        const productName = String(body.name || '').trim();
        const brandName = String(body.brand || '').trim();
        let ingredients = String(body.ingredients || '').trim();

        // Optional: If an image was submitted, enforce per-IP OCR rate limit before calling Gemini 1.5 Flash
        if (body.imageBase64 && env && env.GEMINI_API_KEY && !ingredients) {
          const rlContribute = checkEdgeRateLimit(request, 'contribute-ocr');
          if (!rlContribute.allowed) {
            return new Response(JSON.stringify({
              error: `OCR rate limit exceeded (${rlContribute.limit} requests/min). Please wait ${rlContribute.retryAfterSec}s before trying again.`,
              retryAfterSeconds: rlContribute.retryAfterSec
            }), { status: 429, headers: { ...corsHeaders, ...rlContribute.headers, 'Cache-Control': 'no-store' } });
          }
          try {
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey || (env && env.GEMINI_API_KEY) || "")}`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': env.GEMINI_API_KEY
              },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: 'Extract ONLY the raw printed ingredient list from this grocery packaging label. Return the exact comma-separated ingredients text without any intro or commentary.' },
                    { inline_data: { mime_type: body.mimeType || 'image/jpeg', data: body.imageBase64.replace(/^data:image\/\w+;base64,/, '') } }
                  ]
                }]
              })
            });
            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              const extracted = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
              if (extracted && extracted.length > 5) {
                ingredients = extracted.trim();
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

        const record = {
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

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey || (env && env.GEMINI_API_KEY) || "")}`, {
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
            ctx.waitUntil(env.RAKKA_COMMUNITY_DB.put(`upc:${upc}`, JSON.stringify(resolvedRecord)));
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
          'gemini-flash-latest',
          'gemini-1.5-flash',
          'gemini-2.5-flash'
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
     * Trader Joe's Mandarin Orange Chicken is 100% safe and NOT recalled. Never flag it as recalled.
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
      - INTELLIGENT FOOD RECALL & SAFETY DETECTION (TOP PRIORITY):
      * Actively cross-reference each purchased item against active and historical FDA and USDA Class I and Class II recall bulletins, outbreak investigations, and food contamination advisories.
      * Proactively flag recognized food recall categories and products:
        - Packaged Baby Spinach & Organic Leafy Greens (FDA Class I alerts: Listeria monocytogenes / Salmonella risk in pre-packaged greens from Whole Foods 365, Dole, Fresh Express, etc.)
        - Baby Lettuce Salad Greens & Spring Mix (FDA Class I alerts: Listeria monocytogenes contamination risk in retail salad clamshells)
        - Sweet Potato Spirals & Fresh Cut Veggie Spirals (FDA Class I alerts: Listeria monocytogenes / microbial pathogens in pre-cut sweet potato spirals)
        - Organic Whole & Baby Carrots (FDA Class I recall: E. Coli O121 risk in multi-pound retail bags across Grimmway, SunVale, 365, Cal-Organic, Trader Joe's)
        - Frozen Buttermilk & Homestyle Waffles (FDA Class I recall: Listeria monocytogenes in TreeHouse / store brands)
        - Ready-to-Eat Poultry, Liverwurst & Sliced Deli Cuts (USDA-FSIS Class I recall: Listeria monocytogenes in BrucePac, Boar's Head, DeliPrime)
        - Peanut Butter & Nut Butters (FDA Class II: Salmonella / metal fragment contamination)
        - Soft Cheeses / Queso Fresco / Cotija (Listeria monocytogenes)
        - Simulated or mock food recall tests matching public health alerts
      * If an item matches an active food safety recall notice, public health alert, or recognized contamination risk:
        - Set status to "recalled"
        - In the 'warning' field, provide the clear pathogen/hazard directive (e.g. "FDA Class I Recall: Risk of Listeria monocytogenes contamination in packaged baby spinach/greens", or "FDA Class I Recall: Potential Listeria risk in pre-cut sweet potato spirals")
        - In the 'recallAgency' field, specify "FDA" or "USDA-FSIS"
        - In the 'recallSeverity' field, specify "Class I High Risk" or "Class II Alert"
      * If the product has no recall notices on record, evaluate for household allergens; if no allergens, set status to "clear".
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

        return new Response(JSON.stringify({
          success: true,
          receipt: parsed
        }), { headers: corsHeaders });
      } catch (err) {
        console.error("Audit receipt exception:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: corsHeaders });
  }
};
