# Rakka — Food Safety & Recall Watchdog

Rakka is an intelligent, offline-first food safety and recall watchdog progressive web application (PWA). It protects households from contaminated groceries, undisclosed allergens, and recalled foods by combining live FDA & USDA federal enforcement feeds with instant optical barcode scanning and receipt itemization.

Developed by **Twin Ravens Digital LLC**.

---

## 🛡️ Core Features

- **Live Federal Recall Wire:** Real-time ingestion and semantic parsing of FDA enforcement reports, recalls.gov, and USDA FSIS warning wires.
- **Instant Barcode Scanner:** On-device camera scanning with fallback to our local curated staple catalog (`staples_catalog.json`) and live OpenFoodFacts proxy.
- **Smart Allergen & Additive Accordions:** Clean, color-coded collapsible panels categorizing verified allergens, flagged additives, negative claims (e.g. gluten-free / wheat-free disambiguation), and complete ingredient breakdowns.
- **Pantry & Receipt Watchdog:** OCR-powered grocery receipt parsing that cross-references all purchased items against active federal recalls.
- **Family Profiles:** Multi-user allergen profiles with custom sensitivity thresholds and child safety rules.
- **Offline PWA:** Fully cached service worker (`sw.js`) allowing core scanning, allergen matching, and watchlist lookups even without internet connectivity.

---

## 📂 Repository File Structure

```text
├── index.html              # Main Rakka application interface & PWA container
├── recall_scanner.html     # Dedicated standalone barcode & recall scanner
├── rakka-worker.js         # Cloudflare Worker backend API proxy (FDA, USDA, barcode fallback)
├── staples_catalog.json    # Local catalog dictionary of high-velocity pantry goods
├── sw.js                   # Service Worker providing offline caching
├── manifest.json           # Web App Manifest for mobile installation
├── favicon.png             # Application favicon
├── apple-touch-icon.png    # iOS Safari home screen icon
├── icon-192.png            # Android PWA 192x192 icon
├── icon-512.png            # Android PWA 512x512 splash icon
└── logo-1024.png           # High-resolution Rakka watchdog crest
```

---

## 🚀 Deployment Guide

### 1. Frontend (GitHub Pages / Cloudflare Pages / Vercel)
- **GitHub Pages:**
  1. Push this repository to GitHub.
  2. In your repo settings, go to **Pages**.
  3. Under **Branch**, select `main` and root `/`, then save.
  4. Your app is live at `https://<username>.github.io/<repo>/`!

- **Cloudflare Pages:**
  1. Connect your GitHub repository to Cloudflare Pages.
  2. Build command: None (leave blank).
  3. Output directory: `/` (root).
  4. Deploy!

### 2. Backend Cloudflare Worker (`rakka-worker.js`)
The `rakka-worker.js` script handles CORS proxying, live FDA/USDA recall aggregation, and OpenFoodFacts barcode resolution:
1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **Create application** > **Create Worker**.
2. Name it `rakka-worker`.
3. Paste the contents of `rakka-worker.js` into the online editor and click **Deploy**.
4. If using a custom route or custom domain, update `WORKER_URL` in `index.html` (lines referencing the proxy endpoint).

---

## 🔒 Privacy & Compliance
Rakka processes receipt scans and pantry lists client-side whenever possible. No user personal health information or scanned shopping history is sold or transmitted to third parties.

© Twin Ravens Digital LLC. All rights reserved.
