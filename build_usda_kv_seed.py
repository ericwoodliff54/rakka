#!/usr/bin/env python3
"""
RAKKA Scanner - USDA FoodData Central Bulk KV Ingestion Pipeline
================================================================
This script processes the official USDA FoodData Central (FDC) Branded Foods
dataset to generate clean, verified, dual-indexed Cloudflare KV bulk seed files
(ready for `npx wrangler kv:bulk put`).

Requirements:
1. Download the free "Branded Foods" CSV from USDA FoodData Central:
   https://fdc.nal.usda.gov/download-datasets.html
   Extract: `branded_food.csv` and `food.csv` into the same directory.
2. (Optional) Place `staples_catalog.json` in the same directory to merge
   existing hand-verified staples.
3. Run: `python3 build_usda_kv_seed.py`
"""

import csv
import json
import os
import re
import sys

# ==============================================================================
# 1. ALLERGEN & ADDITIVE DETECTION RULES (DETERMINISTIC)
# ==============================================================================

ALLERGEN_PATTERNS = {
    'milk': [
        r'\bmilk\b', r'\bwhey\b', r'\bcasein\b', r'\bcaseinate\b', r'\bbutter\b',
        r'\bcream\b', r'\bcheese\b', r'\byogurt\b', r'\blactose\b', r'\bghee\b',
        r'\bnonfat milk\b', r'\bbuttermilk\b', r'\bmilkfat\b'
    ],
    'eggs': [
        r'\begg\b', r'\beggs\b', r'\begg white\b', r'\begg yolk\b', r'\balbumin\b',
        r'\bovalbumin\b', r'\bmayonnaise\b'
    ],
    'peanuts': [
        r'\bpeanut\b', r'\bpeanuts\b', r'\bpeanut butter\b', r'\bpeanut flour\b',
        r'\bpeanut oil\b'
    ],
    'tree_nuts': [
        r'\btree nuts?\b', r'\balmonds?\b', r'\bwalnuts?\b', r'\bcashews?\b',
        r'\bpecans?\b', r'\bpistachios?\b', r'\bhazelnuts?\b', r'\bmacadamia\b',
        r'\bbrazil nuts?\b', r'\bpine nuts?\b', r'\bchestnuts?\b'
    ],
    'wheat': [
        r'\bwheat\b', r'\bflour\b', r'\bdurum\b', r'\bsemolina\b', r'\bspelt\b',
        r'\bfarro\b', r'\bkamut\b', r'\bbulgur\b', r'\bwheat bran\b', r'\bwheat germ\b'
    ],
    'gluten': [
        r'\bgluten\b', r'\bwheat\b', r'\bbarley\b', r'\brye\b', r'\boats\b',
        r'\bmalt\b', r'\bmalt extract\b', r'\bmalt syrup\b', r'\bbrewer\'?s yeast\b'
    ],
    'soy': [
        r'\bsoy\b', r'\bsoya\b', r'\bsoybeans?\b', r'\bsoy lecithin\b',
        r'\bsoy protein\b', r'\bsoy sauce\b', r'\btofu\b', r'\bedamame\b'
    ],
    'sesame': [
        r'\bsesame\b', r'\bsesame seeds?\b', r'\btahini\b', r'\bsesame oil\b'
    ],
    'fish': [
        r'\bfish\b', r'\bsalmon\b', r'\btuna\b', r'\bcod\b', r'\btilapia\b',
        r'\banchov(y|ies)\b', r'\bhaddock\b', r'\btrout\b', r'\bhalibut\b'
    ],
    'shellfish': [
        r'\bshellfish\b', r'\bcrustacean\b', r'\bshrimp\b', r'\bcrab\b',
        r'\blobster\b', r'\bprawns?\b', r'\bcrawfish\b', r'\bcrayfish\b'
    ],
    'mustard': [
        r'\bmustard\b', r'\bmustard seed\b', r'\bmustard flour\b'
    ],
    'celery': [
        r'\bcelery\b', r'\bcelery seed\b', r'\bcelery salt\b'
    ],
    'sulfites': [
        r'\bsulfites?\b', r'\bsulphites?\b', r'\bsulfur dioxide\b',
        r'\bsodium bisulfite\b', r'\bpotassium metabisulfite\b'
    ]
}

ADDITIVE_PATTERNS = {
    'en:e171': [r'titanium dioxide'],
    'en:e129': [r'red 40', r'allura red', r'fd&c red no\.? 40'],
    'en:e102': [r'yellow 5', r'tartrazine', r'fd&c yellow no\.? 5'],
    'en:e110': [r'yellow 6', r'sunset yellow', r'fd&c yellow no\.? 6'],
    'en:e133': [r'blue 1', r'brilliant blue', r'fd&c blue no\.? 1'],
    'en:e132': [r'blue 2', r'indigotine', r'fd&c blue no\.? 2'],
    'en:e924a': [r'potassium bromate'],
    'en:e925': [r'chlorine dioxide'],
    'en:e928': [r'benzoyl peroxide'],
    'en:e320': [r'\bbha\b', r'butylated hydroxyanisole'],
    'en:e321': [r'\bbht\b', r'butylated hydroxytoluene'],
    'en:e319': [r'\btbhq\b', r'tertiary butylhydroquinone'],
    'en:e407': [r'carrageenan'],
    'en:e250': [r'sodium nitrite'],
    'en:e251': [r'sodium nitrate'],
    'en:e621': [r'monosodium glutamate', r'\bmsg\b'],
    'en:e951': [r'aspartame'],
    'en:e950': [r'acesulfame potassium', r'acesulfame-k', r'\bace-k\b'],
    'en:e955': [r'sucralose'],
    'en:e954': [r'saccharin'],
    'en:e471': [r'mono-? and diglycerides', r'monoglycerides'],
    'en:e481': [r'sodium stearoyl lactylate'],
    'en:e450': [r'sodium acid pyrophosphate', r'diphosphates'],
    'en:e452': [r'sodium polyphosphate', r'polyphosphates'],
    'en:e202': [r'potassium sorbate'],
    'en:e211': [r'sodium benzoate'],
    'en:e282': [r'calcium propionate'],
    'en:hfcs': [r'high fructose corn syrup', r'\bhfcs\b']
}

# Compile regexes once for maximum performance
COMPILED_ALLERGENS = {
    allergen: [re.compile(p, re.IGNORECASE) for p in patterns]
    for allergen, patterns in ALLERGEN_PATTERNS.items()
}

COMPILED_ADDITIVES = {
    code: [re.compile(p, re.IGNORECASE) for p in patterns]
    for code, patterns in ADDITIVE_PATTERNS.items()
}

# High-priority retail and national CPG brand filters
PRIORITY_BRANDS = [
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
]

def is_valid_upc_check_digit(digits: str) -> bool:
    """Verifies GS1 Modulo-10 check digit for 12-digit UPC-A."""
    if len(digits) != 12 or not digits.isdigit():
        return False
    odds = sum(int(digits[i]) for i in range(0, 11, 2))
    evens = sum(int(digits[i]) for i in range(1, 11, 2))
    total = (odds * 3) + evens
    check = (10 - (total % 10)) % 10
    return check == int(digits[11])

def extract_allergens(ingredients_text: str) -> list:
    if not ingredients_text:
        return []
    found = []
    for allergen, regexes in COMPILED_ALLERGENS.items():
        if any(r.search(ingredients_text) for r in regexes):
            found.append(allergen)
    return found

def extract_additives(ingredients_text: str) -> list:
    if not ingredients_text:
        return []
    found = []
    for code, regexes in COMPILED_ADDITIVES.items():
        if any(r.search(ingredients_text) for r in regexes):
            found.append(code)
    return found

def clean_brand_name(brand_owner: str, brand_name: str) -> str:
    brand = brand_name or brand_owner or 'Grocery Brand'
    brand = re.sub(r',?\s*(Inc\.?|LLC|Corporation|Corp\.?|Co\.?|Ltd\.?)\b', '', brand, flags=re.IGNORECASE)
    return brand.strip().title()

def format_product_name(description: str) -> str:
    if not description:
        return 'Packaged Grocery Item'
    # Remove awkward uppercase screams
    words = description.split()
    if len(words) > 0 and words[0].isupper() and len(description) > 5:
        description = description.title()
    return description.strip()

# ==============================================================================
# 2. MAIN PROCESSING PIPELINE
# ==============================================================================

def process_datasets(target_limit=5000, chunk_size=5000):
    print("=" * 65)
    print(" RAKKA Scanner - USDA FoodData Central Bulk KV Ingestion Pipeline")
    print("=" * 65)

    catalog = {}
    used_upcs = set()

    # Step A: Load existing curated staples if present
    if os.path.exists('staples_catalog.json'):
        print("\n[+] Found staples_catalog.json. Merging pre-verified staples...")
        try:
            with open('staples_catalog.json', 'r', encoding='utf-8') as f:
                curated = json.load(f)
            for raw_upc, item in curated.items():
                digits = re.sub(r'\D', '', str(raw_upc))
                if not digits:
                    continue
                clean_item = {
                    'upc': digits,
                    'name': item.get('product') or item.get('name') or '',
                    'brand': item.get('brand') or '',
                    'ingredients': item.get('ingredients') or '',
                    'allergens': item.get('allergens') or [],
                    'additives': item.get('additives_tags') or item.get('additives') or []
                }
                catalog[digits] = clean_item
                used_upcs.add(digits)
            print(f"    Loaded {len(catalog)} curated staple records.")
        except Exception as e:
            print(f"    Notice: Could not load staples_catalog.json: {e}")

    # Step B: Check for USDA CSV files
    has_usda = os.path.exists('branded_food.csv') and os.path.exists('food.csv')
    if not has_usda:
        print("\n[!] USDA CSV files ('branded_food.csv' and 'food.csv') not found in current folder.")
        print("    To download the full 350,000+ free dataset from USDA:")
        print("    1. Visit: https://fdc.nal.usda.gov/download-datasets.html")
        print("    2. Download 'Branded Foods' CSV package and unzip here.")
        print(f"\n[i] Exporting currently loaded {len(catalog)} records into Wrangler KV format...")
    else:
        print("\n[+] Processing USDA datasets: branded_food.csv and food.csv...")
        
        # Build description mapping from food.csv
        descriptions = {}
        print("    Reading food.csv for product descriptions...")
        with open('food.csv', 'r', encoding='utf-8', errors='ignore') as f:
            reader = csv.DictReader(f)
            for row in reader:
                fdc_id = row.get('fdc_id')
                desc = row.get('description', '')
                if fdc_id:
                    descriptions[fdc_id] = desc

        print(f"    Indexed {len(descriptions):,} food descriptions.")
        print("    Scanning branded_food.csv for high-priority supermarket staples...")

        added_count = 0
        with open('branded_food.csv', 'r', encoding='utf-8', errors='ignore') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if len(catalog) >= target_limit:
                    break

                raw_gtin = row.get('gtin_upc', '')
                digits = re.sub(r'\D', '', str(raw_gtin))
                if len(digits) == 12:
                    upc = digits
                elif len(digits) == 13 and digits.startswith('0'):
                    upc = digits[1:]
                elif len(digits) == 11:
                    # Pad leading zero for 11-digit UPC
                    upc = '0' + digits
                else:
                    continue

                if upc in used_upcs:
                    continue

                # Verify check digit to prevent bad OCR data
                if not is_valid_upc_check_digit(upc):
                    continue

                ingredients = row.get('ingredients', '').strip()
                if not ingredients or len(ingredients) < 8:
                    continue

                brand_owner = (row.get('brand_owner') or '').lower()
                brand_name = (row.get('brand_name') or '').lower()
                category = (row.get('branded_food_category') or '').lower()

                # Filter for high-priority brands or high-volume staple categories
                matches_priority = any(pb in brand_owner or pb in brand_name for pb in PRIORITY_BRANDS)
                is_staple_cat = any(cat in category for cat in [
                    'cereal', 'bread', 'bakery', 'milk', 'cheese', 'yogurt', 'butter',
                    'peanut butter', 'snack', 'waffle', 'pasta', 'sauce', 'poultry', 'soup'
                ])

                if not (matches_priority or is_staple_cat):
                    continue

                fdc_id = row.get('fdc_id')
                raw_desc = descriptions.get(fdc_id) or row.get('subbrand_name') or 'Packaged Grocery Item'
                name = format_product_name(raw_desc)
                brand = clean_brand_name(row.get('brand_owner'), row.get('brand_name'))

                allergens = extract_allergens(ingredients)
                additives = extract_additives(ingredients)

                catalog[upc] = {
                    'upc': upc,
                    'name': name,
                    'brand': brand,
                    'ingredients': ingredients,
                    'allergens': allergens,
                    'additives': additives
                }
                used_upcs.add(upc)
                added_count += 1

                if added_count % 1000 == 0:
                    print(f"    ... ingested {len(catalog):,} / {target_limit:,} products")

        print(f"\n[+] Successfully ingested {added_count:,} new USDA items (Total catalog: {len(catalog):,}).")

    # Step C: Generate dual-indexed Cloudflare KV bulk seed files
    # Dual indexing generates: 'upc:123456789012' AND 'upc:0123456789012'
    print("\n[+] Generating dual-indexed Cloudflare KV bulk seed files...")
    kv_records = []
    for upc, item in catalog.items():
        val_json = json.dumps(item, ensure_ascii=False)
        # 12-digit standard key
        kv_records.append({
            'key': f'upc:{upc}',
            'value': val_json
        })
        # 13-digit padded key (handles phone camera/scanner 0-prefixing)
        if len(upc) == 12:
            kv_records.append({
                'key': f'upc:0{upc}',
                'value': val_json
            })

    output_dir = 'artifacts/file_generation/ttl=63d/output'
    os.makedirs(output_dir, exist_ok=True)

    # Chunk into files of size `chunk_size`
    total_records = len(kv_records)
    part = 1
    batch_files = []

    for i in range(0, total_records, chunk_size):
        chunk = kv_records[i:i + chunk_size]
        filename = f'rakka_community_seed_part{part}.json'
        filepath = os.path.join(output_dir, filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(chunk, f, indent=2, ensure_ascii=False)

        # Also write to local working directory
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(chunk, f, indent=2, ensure_ascii=False)

        size_kb = os.path.getsize(filepath) / 1024
        print(f"    Saved {filename} ({len(chunk):,} keys, {size_kb:.1f} KB)")
        batch_files.append(filename)
        part += 1

    print("\n" + "=" * 65)
    print(" SUMMARY & DEPLOYMENT INSTRUCTIONS")
    print("=" * 65)
    print(f"Total Unique Products : {len(catalog):,}")
    print(f"Total KV Key Entries   : {total_records:,} (dual-indexed)")
    print(f"Output Batches         : {len(batch_files)}")
    print("\nTo upload to Cloudflare KV, run the following commands:")
    for b in batch_files:
        print(f"  npx wrangler kv:bulk put {b} --binding=RAKKA_COMMUNITY_DB")
    print("=" * 65)

if __name__ == '__main__':
    limit = 5000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        limit = int(sys.argv[1])
    process_datasets(target_limit=limit)