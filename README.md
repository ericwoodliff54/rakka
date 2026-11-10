# Rakka — Food Safety & Recall Watchdog

Rakka is an intelligent, offline-first food safety and recall watchdog progressive web application (PWA). It protects households from contaminated groceries, undisclosed allergens, and recalled foods by combining live FDA & USDA federal enforcement feeds with instant optical barcode scanning and receipt itemization.

Developed by **Twin Ravens Digital LLC**.

---

## 🛡️ Core Features & Architecture

- **Live Federal Recall Wire:** 100% free and unlimited real-time ingestion of FDA enforcement reports, recalls.gov, and USDA FSIS warning wires.
- **Instant Barcode Scanner:** 10–11 digit core stem matching (`findRecallRecord`) to ensure check-digit variances never cause active recalls to scan clear.
- **Smart Lot & Date Auditor:** Product-specific recall window parameters (`expectedLots`) for packaging date stamps.
- **Strict Monetization Model:**
  - **RAKKA Free:** 100% free federal recall wire, barcode lookups, pantry watchlist, and full ingredient lists.
  - **RAKKA Plus ($1.99–$2.99/mo):** Unlocks all 12 personal allergen shields, family household profiles (up to 8 members), and chemical additive/dye screening.
- **Two-Stage Receipt Reconciliation:** Instant, zero-delay post-OCR matching against local memory (`GLOBAL_PRODUCT_CACHE`) and Cloudflare KV (`RAKKA_COMMUNITY_DB`), enriching receipts with verified brand names, 30+ ingredients, allergens, and additives with zero added API token cost or timeouts.

---

## 📂 Included Files

```text
├── index.html                  # Main Rakka application interface & PWA container
├── recall_scanner.html         # Dedicated standalone barcode & recall scanner
├── rakka-worker.js             # Cloudflare Worker backend API proxy & edge vision auditor
├── staples_catalog.json        # Curated offline dictionary of grocery staples
├── staples_kv_seed.json        # 1,338 pre-formatted records for Cloudflare KV
├── build_usda_kv_seed.py       # Automated USDA FoodData Central bulk ingestion script
├── sw.js                       # Service Worker providing offline caching
├── manifest.json               # Web App Manifest for mobile installation
├── favicon.png                 # Application favicon
├── apple-touch-icon.png        # iOS Safari home screen icon
├── icon-192.png                # Android PWA 192x192 icon
├── icon-512.png                # Android PWA 512x512 splash icon
└── logo-1024.png               # High-resolution Rakka watchdog crest
```

---

## 🚀 Deployment Guide

### Step 1: Frontend Web Host (GitHub Pages / Cloudflare Pages / Vercel)
Replace `index.html` and `recall_scanner.html` on your web host:
1. Upload `index.html` and `recall_scanner.html` (along with icons/manifest/sw.js if needed) to your hosting repository root.
2. Refresh your browser or clear the PWA service worker cache.

### Step 2: Backend Cloudflare Worker (`rakka-worker.js`)
1. In Cloudflare Dashboard, navigate to **Workers & Pages** > **rakka-edge** (or your worker name).
2. Click **Edit code**.
3. Paste the contents of `rakka-worker.js` and click **Deploy**.

### Step 3: Cloudflare KV Pre-Seeding (`RAKKA_COMMUNITY_DB`)
To pre-seed your cloud database with grocery staples before launch:
1. In your project terminal with Wrangler authenticated, run:
   ```bash
   npx wrangler kv:bulk put staples_kv_seed.json --binding=RAKKA_COMMUNITY_DB
   ```
2. (Optional) To pull and format thousands more items from the free USDA FoodData Central dataset:
   - Download the free "Branded Foods" CSV package from: https://fdc.nal.usda.gov/download-datasets.html
   - Extract `branded_food.csv` and `food.csv` into the same folder as `build_usda_kv_seed.py`.
   - Run:
     ```bash
     python3 build_usda_kv_seed.py 5000
     ```
   - Push the generated batch:
     ```bash
     npx wrangler kv:bulk put rakka_community_seed_part1.json --binding=RAKKA_COMMUNITY_DB
     ```

---

## 🔒 Privacy & Compliance
Rakka processes receipt scans and pantry lists client-side whenever possible. No user personal health information or scanned shopping history is sold or transmitted to third parties.

© Twin Ravens Digital LLC. All rights reserved.
