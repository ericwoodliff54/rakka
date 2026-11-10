#!/usr/bin/env node
/**
 * RAKKA Scanner - USDA FoodData Central Bulk KV Ingestion Pipeline (Node.js)
 * ==========================================================================
 * Pure Node.js implementation (zero dependencies).
 * Reads USDA FoodData Central CSVs and outputs Wrangler-ready Cloudflare KV seed files.
 *
 * Usage:
 *   node build_usda_kv_seed.cjs 5000
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==============================================================================
// 1. ALLERGEN & ADDITIVE DETECTION RULES (DETERMINISTIC)
// ==============================================================================

const ALLERGEN_PATTERNS = {
  milk: [/\bmilk\b/i, /\bwhey\b/i, /\bcasein\b/i, /\bcaseinate\b/i, /\bbutter\b/i, /\bcream\b/i, /\bcheese\b/i, /\byogurt\b/i, /\blactose\b/i, /\bghee\b/i, /\bnonfat milk\b/i, /\bbuttermilk\b/i, /\bmilkfat\b/i],
  eggs: [/\begg\b/i, /\beggs\b/i, /\begg white\b/i, /\begg yolk\b/i, /\balbumin\b/i, /\bovalbumin\b/i, /\bmayonnaise\b/i],
  peanuts: [/\bpeanut\b/i, /\bpeanuts\b/i, /\bpeanut butter\b/i, /\bpeanut flour\b/i, /\bpeanut oil\b/i],
  tree_nuts: [/\btree nuts?\b/i, /\balmonds?\b/i, /\bwalnuts?\b/i, /\bcashews?\b/i, /\bpecans?\b/i, /\bpistachios?\b/i, /\bhazelnuts?\b/i, /\bmacadamia\b/i, /\bbrazil nuts?\b/i, /\bpine nuts?\b/i, /\bchestnuts?\b/i],
  wheat: [/\bwheat\b/i, /\bflour\b/i, /\bdurum\b/i, /\bsemolina\b/i, /\bspelt\b/i, /\bfarro\b/i, /\bkamut\b/i, /\bbulgur\b/i, /\bwheat bran\b/i, /\bwheat germ\b/i],
  gluten: [/\bgluten\b/i, /\bwheat\b/i, /\bbarley\b/i, /\brye\b/i, /\boats\b/i, /\bmalt\b/i, /\bmalt extract\b/i, /\bmalt syrup\b/i, /\bbrewer'?s yeast\b/i],
  soy: [/\bsoy\b/i, /\bsoya\b/i, /\bsoybeans?\b/i, /\bsoy lecithin\b/i, /\bsoy protein\b/i, /\bsoy sauce\b/i, /\btofu\b/i, /\bedamame\b/i],
  sesame: [/\bsesame\b/i, /\bsesame seeds?\b/i, /\btahini\b/i, /\bsesame oil\b/i],
  fish: [/\bfish\b/i, /\bsalmon\b/i, /\btuna\b/i, /\bcod\b/i, /\btilapia\b/i, /\banchov(y|ies)\b/i, /\bhaddock\b/i, /\btrout\b/i, /\bhalibut\b/i],
  shellfish: [/\bshellfish\b/i, /\bcrustacean\b/i, /\bshrimp\b/i, /\bcrab\b/i, /\blobster\b/i, /\bprawns?\b/i, /\bcrawfish\b/i, /\bcrayfish\b/i],
  mustard: [/\bmustard\b/i, /\bmustard seed\b/i, /\bmustard flour\b/i],
  celery: [/\bcelery\b/i, /\bcelery seed\b/i, /\bcelery salt\b/i],
  sulfites: [/\bsulfites?\b/i, /\bsulphites?\b/i, /\bsulfur dioxide\b/i, /\bsodium bisulfite\b/i, /\bpotassium metabisulfite\b/i]
};

const ADDITIVE_PATTERNS = {
  'en:e171': [/titanium dioxide/i],
  'en:e129': [/red 40/i, /allura red/i, /fd&c red no\.? 40/i],
  'en:e102': [/yellow 5/i, /tartrazine/i, /fd&c yellow no\.? 5/i],
  'en:e110': [/yellow 6/i, /sunset yellow/i, /fd&c yellow no\.? 6/i],
  'en:e133': [/blue 1/i, /brilliant blue/i, /fd&c blue no\.? 1/i],
  'en:e132': [/blue 2/i, /indigotine/i, /fd&c blue no\.? 2/i],
  'en:e924a': [/potassium bromate/i],
  'en:e925': [/chlorine dioxide/i],
  'en:e928': [/benzoyl peroxide/i],
  'en:e320': [/\bbha\b/i, /butylated hydroxyanisole/i],
  'en:e321': [/\bbht\b/i, /butylated hydroxytoluene/i],
  'en:e319': [/\btbhq\b/i, /tertiary butylhydroquinone/i],
  'en:e407': [/carrageenan/i],
  'en:e250': [/sodium nitrite/i],
  'en:e251': [/sodium nitrate/i],
  'en:e621': [/monosodium glutamate/i, /\bmsg\b/i],
  'en:e951': [/aspartame/i],
  'en:e950': [/acesulfame potassium/i, /acesulfame-k/i, /\bace-k\b/i],
  'en:e955': [/sucralose/i],
  'en:e954': [/saccharin/i],
  'en:e471': [/mono-? and diglycerides/i, /monoglycerides/i],
  'en:e481': [/sodium stearoyl lactylate/i],
  'en:e450': [/sodium acid pyrophosphate/i, /diphosphates/i],
  'en:e452': [/sodium polyphosphate/i, /polyphosphates/i],
  'en:e202': [/potassium sorbate/i],
  'en:e211': [/sodium benzoate/i],
  'en:e282': [/calcium propionate/i],
  'en:hfcs': [/high fructose corn syrup/i, /\bhfcs\b/i]
};

const PRIORITY_BRANDS = [
  'great value', 'walmart', 'good & gather', 'market pantry', 'favorite day',
  'kroger', 'simple truth', 'roundy', 'private selection',
  'kirkland', 'kirkland signature', 'trader joe', 'trader joe\'s',
  '365 by whole foods', 'whole foods', '365 everyday value',
  'meijer', 'giant eagle', 'albi', 'aldi', 'simply nature', 'millville',
  'kraft', 'heinz', 'general mills', 'kellogg', 'kellogg\'s', 'post',
  'quaker', 'nabisco', 'frito-lay', 'campbell', 'campbell\'s', 'hormel',
  'tyson', 'conagra', 'nestle', 'smucker', 'smucker\'s', 'jif', 'skippy',
  'peter pan', 'stouffer', 'lean cuisine', 'hot pockets', 'dole', 'del monte',
  'green giant', 'birds eye', 'chobani', 'dannon', 'yoplait', 'silk',
  'almond breeze', 'oatly', 'tropicana', 'minute maid', 'barilla'
];

function isValidUpcCheckDigit(digits) {
  if (!digits || digits.length !== 12 || !/^\d+$/.test(digits)) return false;
  let odds = 0, evens = 0;
  for (let i = 0; i < 11; i += 2) odds += parseInt(digits[i], 10);
  for (let i = 1; i < 11; i += 2) evens += parseInt(digits[i], 10);
  const total = (odds * 3) + evens;
  const check = (10 - (total % 10)) % 10;
  return check === parseInt(digits[11], 10);
}

function extractAllergens(text) {
  if (!text) return [];
  const found = [];
  for (const [allergen, regexes] of Object.entries(ALLERGEN_PATTERNS)) {
    if (regexes.some(r => r.test(text))) found.push(allergen);
  }
  return found;
}

function extractAdditives(text) {
  if (!text) return [];
  const found = [];
  for (const [code, regexes] of Object.entries(ADDITIVE_PATTERNS)) {
    if (regexes.some(r => r.test(text))) found.push(code);
  }
  return found;
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// ==============================================================================
// 2. MAIN PROCESSING
// ==============================================================================

async function run() {
  const targetLimit = parseInt(process.argv[2] || '5000', 10);
  console.log('='.repeat(65));
  console.log(' RAKKA Scanner - USDA FoodData Central Bulk KV Ingestion (Node.js)');
  console.log('='.repeat(65));

  const catalog = {};
  const usedUpcs = new Set();

  // Step A: Load staples_catalog.json if present
  if (fs.existsSync('staples_catalog.json')) {
    console.log('\n[+] Found staples_catalog.json. Merging pre-verified staples...');
    try {
      const curated = JSON.parse(fs.readFileSync('staples_catalog.json', 'utf8'));
      for (const [rawUpc, item] of Object.entries(curated)) {
        let digits = rawUpc.replace(/\D/g, '');
        if (!digits) continue;
        if (digits.length === 13 && digits.startsWith('0')) {
          digits = digits.substring(1);
        }
        catalog[digits] = {
          upc: digits,
          name: item.product || item.name || '',
          brand: item.brand || '',
          ingredients: item.ingredients || '',
          allergens: item.allergens || [],
          additives: item.additives_tags || item.additives || []
        };
        usedUpcs.add(digits);
      }
      console.log(`    Loaded ${Object.keys(catalog).length} curated staple records.`);
    } catch (e) {
      console.log(`    Notice: Error reading staples_catalog.json: ${e.message}`);
    }
  }

  const hasUsda = fs.existsSync('branded_food.csv') && fs.existsSync('food.csv');
  if (!hasUsda) {
    console.log('\n[!] USDA CSV files (branded_food.csv and food.csv) not found in folder.');
    console.log('    Download Branded Foods CSV from https://fdc.nal.usda.gov/download-datasets.html');
    console.log(`\n[i] Exporting currently loaded ${Object.keys(catalog).length} records to Wrangler KV...`);
  } else {
    console.log('\n[+] Reading food.csv for product descriptions...');
    const descriptions = {};
    const rlFood = readline.createInterface({
      input: fs.createReadStream('food.csv', { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    let foodHeaders = null;
    let fdcIdx = -1, descIdx = -1;

    for await (const line of rlFood) {
      if (!line.trim()) continue;
      const parts = parseCsvLine(line);
      if (!foodHeaders) {
        foodHeaders = parts.map(p => p.trim());
        fdcIdx = foodHeaders.indexOf('fdc_id');
        descIdx = foodHeaders.indexOf('description');
        continue;
      }
      if (fdcIdx !== -1 && descIdx !== -1 && parts[fdcIdx]) {
        descriptions[parts[fdcIdx]] = parts[descIdx] || '';
      }
    }
    console.log(`    Indexed ${Object.keys(descriptions).length.toLocaleString()} food descriptions.`);

    console.log('    Scanning branded_food.csv for supermarket staples...');
    const rlBranded = readline.createInterface({
      input: fs.createReadStream('branded_food.csv', { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    let bHeaders = null;
    let bFdcIdx = -1, bUpcIdx = -1, bBrandOwnerIdx = -1, bBrandNameIdx = -1, bIngIdx = -1, bSubBrandIdx = -1, bCatIdx = -1;
    let addedCount = 0;

    for await (const line of rlBranded) {
      if (Object.keys(catalog).length >= targetLimit) break;
      if (!line.trim()) continue;
      const parts = parseCsvLine(line);

      if (!bHeaders) {
        bHeaders = parts.map(p => p.trim());
        bFdcIdx = bHeaders.indexOf('fdc_id');
        bUpcIdx = bHeaders.indexOf('gtin_upc');
        bBrandOwnerIdx = bHeaders.indexOf('brand_owner');
        bBrandNameIdx = bHeaders.indexOf('brand_name');
        bSubBrandIdx = bHeaders.indexOf('subbrand_name');
        bIngIdx = bHeaders.indexOf('ingredients');
        bCatIdx = bHeaders.indexOf('branded_food_category');
        continue;
      }

      const rawGtin = parts[bUpcIdx] || '';
      let digits = rawGtin.replace(/\D/g, '');
      let upc = '';

      if (digits.length === 12) {
        upc = digits;
      } else if (digits.length === 13 && digits.startsWith('0')) {
        upc = digits.substring(1);
      } else if (digits.length === 11) {
        upc = '0' + digits;
      } else {
        continue;
      }

      if (usedUpcs.has(upc)) continue;
      if (!isValidUpcCheckDigit(upc)) continue;

      const ingredients = (parts[bIngIdx] || '').trim();
      if (!ingredients || ingredients.length < 8) continue;

      const brandOwner = (parts[bBrandOwnerIdx] || '').toLowerCase();
      const brandName = (parts[bBrandNameIdx] || '').toLowerCase();
      const category = (parts[bCatIdx] || '').toLowerCase();

      // Exclude non-food items (pet food, beauty, personal care)
      const isNonFood = /pet\s*food|dog|cat|bird|litter|shampoo|soap|lotion|cosmetic|cleaner|detergent|paper|towel|napkin|diaper/i.test(category);
      if (isNonFood) continue;

      const fdcId = parts[bFdcIdx];
      const desc = descriptions[fdcId] || parts[bSubBrandIdx] || 'Packaged Grocery Item';
      const rawBrand = parts[bBrandNameIdx] || parts[bBrandOwnerIdx] || 'Grocery Brand';
      const cleanBrand = rawBrand.replace(/,?\s*(Inc\.?|LLC|Corporation|Corp\.?|Co\.?|Ltd\.?)\b/gi, '').trim();

      catalog[upc] = {
        upc,
        name: desc.trim(),
        brand: cleanBrand,
        ingredients,
        allergens: extractAllergens(ingredients),
        additives: extractAdditives(ingredients)
      };

      usedUpcs.add(upc);
      addedCount++;

      if (addedCount % 1000 === 0) {
        console.log(`    ... ingested ${Object.keys(catalog).length.toLocaleString()} / ${targetLimit.toLocaleString()} products`);
      }
    }
    console.log(`\n[+] Successfully ingested ${addedCount.toLocaleString()} new USDA items (Total catalog: ${Object.keys(catalog).length.toLocaleString()}).`);
  }

  // Step C: Generate Wrangler KV records with strict key deduplication
  console.log('\n[+] Generating dual-indexed Cloudflare KV bulk seed files with unique keys...');
  const kvMap = new Map();
  for (const [upc, item] of Object.entries(catalog)) {
    let baseUpc = upc.replace(/\D/g, '');
    if (baseUpc.length === 13 && baseUpc.startsWith('0')) {
      baseUpc = baseUpc.substring(1);
    }
    const valJson = JSON.stringify(item);
    kvMap.set(`upc:${baseUpc}`, valJson);
    if (baseUpc.length === 12) {
      kvMap.set(`upc:0${baseUpc}`, valJson);
    }
  }

  const kvRecords = Array.from(kvMap.entries()).map(([key, value]) => ({ key, value }));

  const chunkSize = 10000;
  let part = 1;
  const batchFiles = [];

  for (let i = 0; i < kvRecords.length; i += chunkSize) {
    const chunk = kvRecords.slice(i, i + chunkSize);
    const filename = `rakka_community_seed_part${part}.json`;
    fs.writeFileSync(filename, JSON.stringify(chunk, null, 2), 'utf8');
    const sizeKb = fs.statSync(filename).size / 1024;
    console.log(`    Saved ${filename} (${chunk.length.toLocaleString()} unique keys, ${sizeKb.toFixed(1)} KB)`);
    batchFiles.push(filename);
    part++;
  }

  console.log('\n' + '='.repeat(65));
  console.log(' SUMMARY & DEPLOYMENT INSTRUCTIONS');
  console.log('='.repeat(65));
  console.log(`Total Unique Products : ${Object.keys(catalog).length.toLocaleString()}`);
  console.log(`Total Unique KV Keys   : ${kvRecords.length.toLocaleString()} (guaranteed unique)`);
  console.log(`Output Batches         : ${batchFiles.length}`);
  console.log('\nTo upload to Cloudflare KV, run the following commands:');
  for (const b of batchFiles) {
    console.log(`  npx wrangler kv bulk put ${b} --namespace-id=PASTE_YOUR_ID_HERE --remote`);
  }
  console.log('='.repeat(65));
}

run().catch(console.error);
