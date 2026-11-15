// Allergen detection. Pure functions, no DOM.
// Three confidence levels (never a bare "safe"):
//   contains     a clear ingredient term, or the manufacturer declared it
//   may-contain  appears only in a "may contain / shared facility" statement
//   possible     ambiguous derivative (e.g. dextrose for corn) or only hinted by the product NAME
// Ids match the existing app: gluten, dairy, peanuts, treenuts, soy, eggs, fish, shellfish, sesame, corn, sulfites, yeast.

import { normalizeText, phraseRegex } from './text.js';

const NON_WHEAT_FLOURS = ['almond','coconut','rice','brown rice','tapioca','cassava','chickpea','garbanzo','sorghum','millet','buckwheat','quinoa','amaranth','teff','potato','corn','soy','lupin','tigernut','plantain','cauliflower','arrowroot','pea','bean','fava','lentil'].map((f) => f + ' flour');
const PLANT_MILKS = ['almond','oat','soy','rice','cashew','hemp','pea','coconut','macadamia','flax'].flatMap((p) => [p + ' milk', p + ' cream', p + ' creamer']);
const FREE = (w) => [w + ' free', 'free from ' + w, 'without ' + w, 'no ' + w, 'contains no ' + w];

export const ALLERGENS = {
  gluten: {
    label: 'Gluten / wheat',
    contains: ['gluten','wheat','wheat flour','wheat starch','barley','rye','malt','malted barley','malt extract','malt vinegar','semolina','spelt','farro','durum','kamut','khorasan','triticale','einkorn','emmer','bulgur','couscous','seitan','graham','enriched flour','bleached flour','unbleached flour','all purpose flour','bread flour','cake flour','pastry flour','self rising flour','farina'],
    possible: ['flour','oat','oats','soy sauce','teriyaki','breading','breadcrumbs','bread crumbs','panko','roux','orzo','beer'],
    nameHints: ['bread','bun','bagel','cake','cookie','donut','doughnut','cracker','pasta','noodle','spaghetti','macaroni','pizza','cereal','pretzel','waffle','pancake','muffin','brownie','biscuit','tortilla','pie','croissant','pita','ramen'],
    exclusions: [...NON_WHEAT_FLOURS, ...FREE('gluten'), ...FREE('wheat'), 'buckwheat'],
  },
  dairy: {
    label: 'Milk / dairy',
    contains: ['dairy','milk','milk powder','milk solids','milk fat','milkfat','butterfat','butter','buttermilk','cream','heavy cream','sour cream','half and half','cheese','cheddar','mozzarella','parmesan','romano','gouda','swiss','provolone','brie','feta','ricotta','mascarpone','curd','curds','ghee','whey','casein','caseinate','lactose','lactalbumin','lactoglobulin','yogurt','yoghurt','kefir','custard','ice cream','gelato','paneer','quark','milk protein','whey protein','evaporated milk','condensed milk'],
    possible: ['creamer','nougat','caramel'],
    nameHints: [],
    exclusions: [...PLANT_MILKS, ...FREE('dairy'), ...FREE('milk'), ...FREE('lactose'), 'cocoa butter','shea butter','peanut butter','almond butter','cashew butter','sunflower seed butter','sunflower butter','nut butter','seed butter','apple butter','butter bean','butter beans','cream of tartar','non dairy'],
  },
  peanuts: {
    label: 'Peanuts',
    contains: ['peanut','peanut butter','peanut oil','peanut flour','arachis','groundnut','ground nut','beer nuts'],
    possible: ['mixed nuts','assorted nuts','trail mix','nut butter','nuts','satay'],
    nameHints: [],
    exclusions: [...FREE('peanut'), ...FREE('peanuts')],
  },
  treenuts: {
    label: 'Tree nuts',
    contains: ['almond','cashew','walnut','pecan','pistachio','hazelnut','filbert','macadamia','pine nut','pinenut','pignoli','brazil nut','chestnut','praline','marzipan','gianduja','nut paste','tree nut','hickory nut','beechnut'],
    possible: ['mixed nuts','assorted nuts','trail mix','nut butter','nuts','nougat','amaretto','frangipane','orgeat'],
    possibleAlways: ['water chestnut'],   // not a tree nut botanically, but some databases list it as one: flag as a caution
    nameHints: [],
    exclusions: ['water chestnut','water chestnuts', ...FREE('tree nut'), ...FREE('nut')],
  },
  soy: {
    label: 'Soy',
    contains: ['soy','soya','soybean','soy flour','soy protein','soy lecithin','soy sauce','edamame','tofu','tempeh','miso','tamari','shoyu','natto','tvp','textured vegetable protein'],
    possible: ['lecithin','vegetable protein','hydrolyzed vegetable protein','hvp'],
    nameHints: [],
    exclusions: ['sunflower lecithin','rapeseed lecithin','canola lecithin','egg lecithin', ...FREE('soy')],
  },
  eggs: {
    label: 'Eggs',
    contains: ['egg','egg white','eggwhite','egg yolk','eggyolk','dried egg','albumin','albumen','ovalbumin','ovomucoid','ovomucin','ovovitellin','ovoglobulin','livetin','lysozyme','mayonnaise','mayo','meringue','eggnog'],
    possible: [],
    nameHints: [],
    exclusions: ['eggplant','eggless', ...FREE('egg'), ...FREE('eggs')],
  },
  fish: {
    label: 'Fish',
    contains: ['fish','salmon','tuna','cod','tilapia','halibut','pollock','anchovy','anchovies','trout','haddock','sardine','mackerel','snapper','bass','catfish','herring','flounder','swordfish','mahi mahi','perch','carp','eel','fish sauce','fish oil','fish gelatin','surimi','kamaboko','caviar','bonito','dashi'],
    possible: ['worcestershire','caesar','imitation crab'],
    nameHints: [],
    exclusions: ['swedish fish','gummy fish', ...FREE('fish')],
  },
  shellfish: {
    label: 'Shellfish',
    contains: ['shrimp','prawn','crab','lobster','crawfish','crayfish','krill','langoustine','crustacean','shellfish','clam','mussel','oyster','scallop','squid','calamari','octopus','abalone','escargot','cockle','whelk','conch','oyster sauce'],
    possible: ['seafood'],
    nameHints: [],
    exclusions: ['crab apple','crabapple','oyster cracker','oyster crackers', ...FREE('shellfish')],
  },
  sesame: {
    label: 'Sesame',
    contains: ['sesame','sesame seed','sesame oil','tahini','benne','gingelly','sesamum','halvah','halva'],
    possible: ['hummus','everything bagel','everything seasoning','zaatar','za atar','dukkah','gomashio','furikake','falafel','baba ganoush'],
    nameHints: [],
    exclusions: [...FREE('sesame')],
  },
  corn: {
    label: 'Corn',
    contains: ['corn','cornstarch','cornmeal','cornflour','cornflakes','cornbread','popcorn','sweetcorn','maize','masa','polenta','grits','hominy','hfcs','zein'],
    possible: ['dextrose','maltodextrin','dextrin','modified food starch','modified starch','food starch','citric acid','xanthan gum','caramel color','sorbitol','baking powder','ascorbic acid','glucose syrup','fructose'],
    nameHints: [],
    exclusions: ['peppercorn','acorn','unicorn','capricorn', ...FREE('corn')],
  },
  sulfites: {
    label: 'Sulfites',
    contains: ['sulfite','sulphite','sulfur dioxide','sulphur dioxide','bisulfite','metabisulfite','sulfiting agent'],
    extra: [/\be22[0-8]\b/g],
    possible: [],
    nameHints: [],
    exclusions: [...FREE('sulfite'), ...FREE('sulfites')],
  },
  yeast: {
    label: 'Yeast',
    contains: ['yeast','yeast extract','autolyzed yeast','hydrolyzed yeast','brewers yeast','nutritional yeast','saccharomyces','torula','marmite','vegemite','bakers yeast','levure','levadura','lievito','hefe'],
    possible: ['bread','beer','wine','kombucha','sourdough','soy sauce','fermented'],
    nameHints: [],
    exclusions: [...FREE('yeast')],
  },
};

export const ALLERGEN_IDS = Object.keys(ALLERGENS);

// Words people / databases use for the ids above.
const ALIASES = {
  milk: 'dairy', dairy: 'dairy', 'milk and dairy': 'dairy',
  wheat: 'gluten', gluten: 'gluten', 'wheat gluten': 'gluten', 'cereals containing gluten': 'gluten',
  egg: 'eggs', eggs: 'eggs', peanut: 'peanuts', peanuts: 'peanuts',
  'tree nut': 'treenuts', 'tree nuts': 'treenuts', treenuts: 'treenuts', nuts: 'treenuts',
  soy: 'soy', soya: 'soy', soybean: 'soy', soybeans: 'soy',
  fish: 'fish', shellfish: 'shellfish', 'crustacean shellfish': 'shellfish', crustacean: 'shellfish', crustaceans: 'shellfish', molluscs: 'shellfish', mollusks: 'shellfish',
  sesame: 'sesame', 'sesame seeds': 'sesame', 'sesame seed': 'sesame',
  corn: 'corn', sulfites: 'sulfites', sulphites: 'sulfites', 'sulfur dioxide': 'sulfites', 'sulphur dioxide and sulphites': 'sulfites', 'sulfur dioxide and sulfites': 'sulfites', yeast: 'yeast',
};

export function normalizeAllergenId(value) {
  const k = normalizeText(String(value || '').replace(/^en:/i, ''));
  return ALIASES[k] || (ALLERGENS[k] ? k : null);
}

const PRECAUTION = /\b(?:may contain|might contain|could contain|can contain|(?:produced|processed|manufactured|made|packaged|packed) (?:in|on) (?:a |an |the )?(?:shared )?(?:facility|facilities|equipment|line)|shares? (?:a )?(?:facility|equipment|line)|facility (?:that|which) (?:also )?(?:processes|handles|uses|produces|makes))\b[^.;\n]*/g;

const RANK = { 'contains': 3, 'may-contain': 2, 'possible': 1 };
const MAX_EVIDENCE = 5;

function scan(text, id, terms, flags) {
  const def = ALLERGENS[id];
  let t = text;
  const ex = phraseRegex(def.exclusions);
  if (ex) t = t.replace(ex, ' ');
  const hits = new Set();
  const re = phraseRegex(terms);
  if (re) for (const m of t.matchAll(re)) hits.add(m[0].trim());
  if (flags === 'contains' && def.extra) for (const x of def.extra) for (const m of t.matchAll(x)) hits.add(m[0].trim());
  return [...hits];
}

/**
 * analyzeAllergens({ ingredients, name, declared }) ->
 *  { findings:[{allergen, label, level, source, evidence[]}], ingredientData:'none'|'thin'|'ok' }
 * `declared` is an array of allergen names a database lists for the product.
 */
export function analyzeAllergens({ ingredients = '', name = '', declared = [] } = {}) {
  const ing = normalizeText(ingredients);
  const precautions = [];
  const mainText = ing.replace(PRECAUTION, (m) => { precautions.push(m); return ' '; });
  const nameText = normalizeText(name);
  const found = new Map();

  const record = (allergen, level, source, evidence) => {
    const cur = found.get(allergen);
    if (!cur) { found.set(allergen, { allergen, label: ALLERGENS[allergen].label, level, source, evidence: [...evidence].slice(0, MAX_EVIDENCE) }); return; }
    if (RANK[level] > RANK[cur.level]) { cur.level = level; cur.source = source; }
    for (const e of evidence) if (!cur.evidence.includes(e) && cur.evidence.length < MAX_EVIDENCE) cur.evidence.push(e);
  };

  for (const d of declared || []) {
    const id = normalizeAllergenId(d);
    if (id) record(id, 'contains', 'declared', [String(d)]);
  }
  for (const id of ALLERGEN_IDS) {
    const def = ALLERGENS[id];
    const hard = scan(mainText, id, def.contains, 'contains');
    if (hard.length) record(id, 'contains', 'ingredients', hard);
    const soft = scan(mainText, id, def.possible, 'possible');
    if (soft.length) record(id, 'possible', 'ingredients', soft);
    if (def.possibleAlways) {
      const re = phraseRegex(def.possibleAlways);
      const h = re ? [...mainText.matchAll(re)].map((m) => m[0].trim()) : [];
      if (h.length) record(id, 'possible', 'ingredients', h);
    }
    for (const clause of precautions) {
      const p = [...scan(clause, id, def.contains, 'contains'), ...scan(clause, id, def.possible, 'possible')];
      if (p.length) record(id, 'may-contain', 'precautionary statement', p);
    }
    if (nameText) {
      const n = [...scan(nameText, id, def.contains, 'contains'), ...scan(nameText, id, def.nameHints || [], 'possible')];
      if (n.length) record(id, 'possible', 'product name', n);
    }
  }
  const words = ing.split(/[\s,;.:]+/).filter(Boolean).length;
  return { findings: [...found.values()], ingredientData: !ing ? 'none' : words < 3 ? 'thin' : 'ok' };
}
