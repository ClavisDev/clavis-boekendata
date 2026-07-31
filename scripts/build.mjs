/**
 * Build van de statische datalaag voor de boekenzoeker onderwijs.
 *
 * Leest source/ (nooit met de hand wijzigen — komt als geheel van de redactie) en
 * schrijft data/. Alles onder data/ is gegenereerd en wegwerpbaar: verwijder je het,
 * dan bouwt de volgende run het opnieuw.
 *
 *   data/meta.json           versie (inhoudshash) + generatiedatum + facetwaarden
 *   data/index.json          één lichte rij per titel — zoeken, filteren, kaartjes
 *   data/doelen.json         de doelencatalogus, elk doel exact één keer
 *   data/doelen-index.json   doelcode -> ISBN's (omgekeerde index, incl. koepelcodes)
 *   data/themacodes.json     themacode -> omschrijving
 *   data/titels/<isbn>.json  volledig detail per titel, doelen als code
 *   data/covers-manifest.txt welke covers de site nodig heeft (voedt build-covers.zsh)
 *
 * Waarom een build en niet de bron serveren: het overgrote deel van boekmappings.json
 * is duplicatie. Er zijn 192 unieke minimumdoelen, maar hun koepeluitwerking staat
 * 59.096 keer herhaald over de titels. Die zet de build één keer apart in doelen.json;
 * de titels verwijzen er met een code naar. Terugvouwen doet doelen-hydratatie.js
 * client-side.
 *
 * Wat er per titel blijft staan en waarom (gemeten op de bron, niet aangenomen):
 *   - `redactie` bij een doel varieert per titel (39 van 192 minimumdoelcodes,
 *     16 van 29 kerndoelcodes) — dat is per-titel motivatie, geen catalogusdata.
 *   - welke `subdoelen` van een kerndoel gelden varieert per titel (9 van 29);
 *     de doelzin per letter is wél stabiel (0 van 42 wijkt af) en gaat naar de catalogus.
 *   - `redactie` is afwezig, niet null, als er geen redactie is; en één kerndoel heeft
 *     helemaal geen `subdoelen`-sleutel. Beide geven we letterlijk zo terug.
 *
 * Eigenschappen waar de rest van de keten op mag rekenen:
 *   - Idempotent. Twee keer draaien geeft byte-identieke output: objectsleutels worden
 *     diep gesorteerd en er staat geen tijdstempel in de output. Een regeneratie zonder
 *     inhoudelijke wijziging geeft dus geen git-diff, zodat echte wijzigingen opvallen.
 *   - Valideert en faalt hard. Bij een harde fout wordt er niets weggeschreven en blijft
 *     een eerdere goede data/ ongemoeid. Ontbrekende cover of flaptekst is een
 *     waarschuwing, geen fout.
 *   - Ruimt op. Titels die uit de bron verdwijnen, verdwijnen uit data/titels/.
 *   - Geen voorraad. Leverbaarheid komt live uit Shopify; een momentopname in de JSON
 *     zou die tegenspreken.
 *
 * Optioneel: source/niveau-mapping.json normaliseert de vrije velden `niveau` en
 * `leeftijd` naar `graden` en `leeftijd_min`. Vorm:
 *   { "niveau":   { "<ruwe waarde>": { "graden": [1,2], "leeftijd_min": 6 } },
 *     "leeftijd": { "<ruwe waarde>": { "leeftijd_min": 6 } } }
 * Bestaat het bestand niet, dan blijven die velden null en werkt de rest gewoon.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'source');
const DATA = join(ROOT, 'data');
const TITELS = join(DATA, 'titels');
const COVERS = join(ROOT, 'covers');

const KOEPELNETTEN = ['GO!', 'OVSG', 'Op.stap'];

/* ---------- bron inlezen ---------- */

// De redactie levert gezipt (de rauwe bron is 25 MB). Een platte .json in source/
// wordt ook geaccepteerd, handig bij lokaal proberen.
function leesBron(naam, { verplicht = false } = {}) {
  const gz = join(SOURCE, `${naam}.gz`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'));
  const plat = join(SOURCE, naam);
  if (existsSync(plat)) return JSON.parse(readFileSync(plat, 'utf8'));
  if (verplicht) {
    console.error(`\n⛔ source/${naam}(.gz) ontbreekt. Dit is de bron van de hele datalaag;`);
    console.error(`   zonder dat bestand valt er niets te bouwen. Vraag de redactie om een`);
    console.error(`   nieuw overdrachtspakket en zet het bestand in source/.\n`);
    process.exit(1);
  }
  return null;
}

const bron = leesBron('boekmappings.json', { verplicht: true });
const titels = bron.titels ?? [];

// Rijkere woordenschat dan het ingebedde veld (376 ISBN's, deels andere woorden).
// Voedt de zoektekst en de woordenwolk; ontbreekt het bestand, dan valt de build
// terug op alleen het ingebedde veld.
const woordenschatLos = leesBron('woordenschat.json') ?? {};
const niveauMapping = existsSync(join(SOURCE, 'niveau-mapping.json'))
  ? JSON.parse(readFileSync(join(SOURCE, 'niveau-mapping.json'), 'utf8'))
  : null;

/* ---------- determinisme ---------- */

// Objectsleutels diep sorteren; array-orde blijft staan (die is inhoudelijk:
// blokvolgorde, subdoelletters, koepellijsten).
function canoniek(waarde) {
  if (Array.isArray(waarde)) return waarde.map(canoniek);
  if (waarde && typeof waarde === 'object') {
    const uit = {};
    for (const sleutel of Object.keys(waarde).sort()) uit[sleutel] = canoniek(waarde[sleutel]);
    return uit;
  }
  return waarde;
}

const naarJson = (waarde, ruim = false) => JSON.stringify(canoniek(waarde), null, ruim ? 2 : undefined);
const hash = (tekst) => createHash('sha256').update(tekst).digest('hex');

// Sorteren op code-eenheid, niet met localeCompare: dat laatste hangt af van de
// ICU-locale van de machine en zou dezelfde data op de ene machine anders ordenen dan
// op de andere. De sorteerorde bepaalt de sleutelvolgorde in de output én de
// inhoudshash, dus die moet overal gelijk zijn.
const opCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------- normalisatie ---------- */

const NIVEAU_BUCKETS = ['peuter', 'kleuter', 'lager-onderbouw', 'lager-bovenbouw', 'oudere-lezer', 'young-adult'];

// `niveau` is vrije tekst met ±25 varianten. Voor het filterfacet vertalen we elk
// deel naar een vaste bucket; onbekende delen komen in het rapport, niet in het facet.
function niveauFacets(niveauRaw, onbekend) {
  const facets = new Set();
  for (let deel of String(niveauRaw ?? '').split('/')) {
    deel = deel.trim().toLowerCase();
    if (!deel) continue;
    if (deel === 'peuter') facets.add('peuter');
    else if (deel === 'kleuter') facets.add('kleuter');
    else if (deel === 'lager-onderbouw') facets.add('lager-onderbouw');
    else if (deel === 'lager-bovenbouw') facets.add('lager-bovenbouw');
    else if (deel === 'lager (onder- tot bovenbouw)') { facets.add('lager-onderbouw'); facets.add('lager-bovenbouw'); }
    else if (/^lager \((6|7)\+\)/.test(deel)) facets.add('lager-onderbouw');
    else if (/^lager \((8|9|10)\+\)/.test(deel)) facets.add('lager-bovenbouw');
    else if (deel.startsWith('oudere lezer')) facets.add('oudere-lezer');
    else if (deel.startsWith('young adult')) facets.add('young-adult');
    else if (deel === 'secundair') facets.add('young-adult');
    else if (deel === 'alle leeftijden' || deel.startsWith('voor ')) { /* bewust geen facet */ }
    else onbekend.set(deel, (onbekend.get(deel) ?? 0) + 1);
  }
  return NIVEAU_BUCKETS.filter((bucket) => facets.has(bucket));
}

// Liever leeg dan gokken: zonder mapping blijven graden en leeftijd_min null.
function genormaliseerdNiveau(t) {
  if (!niveauMapping) return { graden: null, leeftijd_min: null };
  const viaNiveau = niveauMapping.niveau?.[t.niveau ?? ''] ?? null;
  const viaLeeftijd = niveauMapping.leeftijd?.[t.leeftijd ?? ''] ?? null;
  return {
    graden: viaNiveau?.graden ?? null,
    leeftijd_min: viaNiveau?.leeftijd_min ?? viaLeeftijd?.leeftijd_min ?? null,
  };
}

// De CDN levert voor titels zonder echte cover een Magento-placeholder (1526 bytes).
// Zo'n titel behandelen we als "geen cover": de site toont dan de titel als tekst,
// geen webshop-logo van een derde partij.
const MAGENTO_PLACEHOLDER_MD5 = '7e587d4eafa3e9875d44f34a49f886a8';
const coverHashCache = new Map();

function isPlaceholderCover(naam) {
  if (!coverHashCache.has(naam)) {
    const pad = join(COVERS, naam);
    // de placeholder is 1,5 kB; grote bestanden zijn zeker echte covers
    if (statSync(pad).size > 20000) coverHashCache.set(naam, false);
    else coverHashCache.set(naam, createHash('md5').update(readFileSync(pad)).digest('hex') === MAGENTO_PLACEHOLDER_MD5);
  }
  return coverHashCache.get(naam);
}

// Speelgoed heeft deels file:///C:/...-paden in cover_url — nooit als url gebruiken.
// Voorkeur toy-<ean>.png; bestaat die niet, dan cover-<ean>.jpg (enkele titels hebben
// alleen dát bestand, met echte JPEG-inhoud).
function coverInfo(t) {
  const isSpeelgoed = t.categorie === 'Speelgoed';
  const cdn = typeof t.cover_url === 'string' && /^https?:\/\//.test(t.cover_url) ? t.cover_url : null;
  const kandidaten = isSpeelgoed
    ? [`toy-${t.ean || t.isbn}.png`, `cover-${t.ean || t.isbn}.jpg`]
    : [`cover-${t.isbn}.jpg`];
  const lokaalNaam = kandidaten.find((naam) => existsSync(join(COVERS, naam))) ?? null;
  // placeholder lokaal betekent dat de cdn-url hetzelfde plaatje levert: allebei leeg
  if (lokaalNaam && isPlaceholderCover(lokaalNaam)) return { cdn: null, lokaal: null, placeholder: true };
  return { cdn, lokaal: lokaalNaam ? `covers/${lokaalNaam}` : null };
}

// `#NO MATCH` is een sentinel uit de classificatiestap, geen thema. Aan een leerkracht
// tonen we die niet — filteren en melden.
const isEchteThemacode = (tc) => tc?.code && !String(tc.code).startsWith('#');

function themacodesVan(t) {
  return (t.themacodes ?? []).filter(isEchteThemacode);
}

function woordenschatSamen(t) {
  const ingebed = t.woordenschat ?? [];
  const extern = woordenschatLos[t.isbn] ?? [];
  const gezien = new Set(ingebed.map((w) => String(w).toLowerCase()));
  const extra = extern.filter((w) => !gezien.has(String(w).toLowerCase()));
  return { alles: [...ingebed, ...extra], extra };
}

// Vrije zoektekst matcht bewust breed: titel, makers, trefwoorden, flaptekst,
// duiding.kort, themabeschrijvingen en woordenschat. Geen synoniemenlaag.
function zoektekst(t, woorden) {
  return [
    t.titel, t.reeks, t.auteur, t.illustrator,
    ...(t.trefwoorden ?? []),
    t.flaptekst, t.duiding?.kort,
    ...themacodesVan(t).map((tc) => tc.omschrijving),
    ...woorden,
  ].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ---------- stap 1: valideren, nog niets schrijven ---------- */

const fouten = [];         // hard: er wordt niets weggeschreven
const waarschuwingen = []; // voor team/redactie: bouwen kan, wel melden

const tel = (obj, sleutel) => { const k = sleutel ?? '(leeg)'; obj[k] = (obj[k] ?? 0) + 1; };
const perStatus = {}, perCategorie = {}, perHerkomst = {}, perScreeningsbron = {}, perHoofdpijler = {};
const onbekendNiveau = new Map();
const isbnGezien = new Map();
const coversOntbrekend = [], coverPlaceholder = [], fileUrlCovers = [];
const zonderVl = [], zonderNl = [], zonderBeide = [];
const toonregelHits = [], mojibakeHits = [];
const disciplinePerCode = new Map();
const themacodeSentinels = new Set();
const woordenschatDivergentie = { isbns: 0, extraWoorden: 0 };
let metVragen = 0, metLeerkansen = 0, moeilijk = 0, koepelVermeldingen = 0;
const koepelLeeg = { 'GO!': 0, OVSG: 0, 'Op.stap': 0 };
// Koepeldoelen met een lege `code`: die hebben wel structuur en label, maar niets om
// op op te zoeken. Ze blijven in doelen.json staan (de fiche toont ze), maar ze komen
// niet in de omgekeerde index — anders belanden ze allemaal onder één lege sleutel.
const koepelZonderCode = { 'GO!': 0, OVSG: 0, 'Op.stap': 0 };

// De catalogus wordt tijdens de validatie opgebouwd: elk doel één keer, en elke
// volgende vermelding moet daar exact mee overeenkomen. Wijkt hij af, dan spreekt
// de bron zichzelf tegen en stopt de build — dedupliceren zou dan stil verlies zijn.
const minimumdoelen = new Map();  // code -> { ankermoment, omschrijving, koepels }
const kerndoelen = new Map();     // code -> { kernzin, subdoelen: { letter: doelzin } }
const doelenIndex = new Map();    // doelcode (ook koepelcodes) -> Set<isbn>

const naarIndex = (code, isbn) => {
  if (!code) return;
  if (!doelenIndex.has(code)) doelenIndex.set(code, new Set());
  doelenIndex.get(code).add(isbn);
};

if (bron.aantal !== titels.length) {
  fouten.push(`De bron zegt aantal=${bron.aantal}, maar bevat ${titels.length} titels. Het overdrachtspakket is mogelijk onvolledig.`);
}

for (const t of titels) {
  tel(perStatus, t.status); tel(perCategorie, t.categorie); tel(perHerkomst, t.herkomst);
  tel(perScreeningsbron, t.screeningsbron); tel(perHoofdpijler, t.klavertjevier?.hoofdpijler);

  if (!/^\d{13}$/.test(String(t.isbn))) fouten.push(`Geen 13-cijferige sleutel: "${t.isbn}" bij "${t.titel ?? '(zonder titel)'}"`);
  if (isbnGezien.has(t.isbn)) fouten.push(`Dubbele sleutel ${t.isbn}: "${isbnGezien.get(t.isbn)}" en "${t.titel}"`);
  isbnGezien.set(t.isbn, t.titel);
  if (!t.titel) fouten.push(`Titel ontbreekt bij ${t.isbn}`);

  if (t.vragen) metVragen++;
  if (t.leerkansen) metLeerkansen++;
  if (t.mapping_moeilijk) moeilijk++;
  if (t.mapping_moeilijk && !t.mapping_moeilijk_reden) {
    waarschuwingen.push(`${t.isbn} heeft mapping_moeilijk zonder reden; de fiche hoort die reden te tonen.`);
  }

  if (String(t.cover_url ?? '').startsWith('file:')) fileUrlCovers.push(t.isbn);
  const cover = coverInfo(t);
  if (cover.placeholder) coverPlaceholder.push(`${t.isbn} — ${t.titel}`);
  else if (!cover.lokaal) coversOntbrekend.push(`${t.isbn} — ${t.titel} (${t.categorie}${cover.cdn ? ', wel CDN-url' : ', ook geen CDN-url'})`);

  for (const tc of t.themacodes ?? []) if (!isEchteThemacode(tc)) themacodeSentinels.add(String(tc.code));

  const heeftVl = (t.vlaanderen ?? []).length > 0;
  const heeftNl = (t.nederland ?? []).length > 0;
  if (!heeftVl) zonderVl.push(t.isbn);
  if (!heeftNl) zonderNl.push(t.isbn);
  if (!heeftVl && !heeftNl) zonderBeide.push(`${t.isbn} — ${t.titel}${t.mapping_moeilijk ? ' [mapping_moeilijk]' : ''}`);

  /* Vlaams spoor: minimumdoelen + koepelvertalingen */
  for (const blok of t.vlaanderen ?? []) {
    for (const md of blok.minimumdoelen ?? []) {
      koepelVermeldingen++;
      if (!md.code) { fouten.push(`Minimumdoel zonder code bij ${t.isbn} (${blok.discipline}).`); continue; }
      if (!md.omschrijving) fouten.push(`Minimumdoel ${md.code} bij ${t.isbn} heeft geen omschrijving; onbekende doelcode kan niet naar de catalogus.`);

      naarIndex(md.code, t.isbn);
      if (!disciplinePerCode.has(md.code)) disciplinePerCode.set(md.code, new Set());
      disciplinePerCode.get(md.code).add(blok.discipline);

      const kern = {
        ankermoment: md.ankermoment ?? null,
        omschrijving: md.omschrijving ?? null,
        koepels: Object.fromEntries(KOEPELNETTEN.map((net) => [net, md.koepels?.[net] ?? []])),
      };
      const bestaand = minimumdoelen.get(md.code);
      if (!bestaand) minimumdoelen.set(md.code, kern);
      else if (naarJson(bestaand) !== naarJson(kern)) {
        fouten.push(`Tegenstrijdige doeltekst voor ${md.code}: de bron geeft er meer dan één uitwerking voor (o.a. bij ${t.isbn}). Dedupliceren zou informatie verliezen.`);
      }

      for (const net of KOEPELNETTEN) {
        const lijst = md.koepels?.[net] ?? [];
        if (!lijst.length) koepelLeeg[net]++;
        for (const koepeldoel of lijst) {
          if (!koepeldoel.code) koepelZonderCode[net]++;
          naarIndex(koepeldoel.code, t.isbn);
        }
      }
    }
  }

  /* Nederlands spoor: kerndoelen + subdoelen */
  for (const blok of t.nederland ?? []) {
    for (const kd of blok.kerndoelen ?? []) {
      if (!kd.code) { fouten.push(`Kerndoel zonder code bij ${t.isbn} (${blok.leergebied}).`); continue; }
      if (!kd.kernzin) fouten.push(`Kerndoel ${kd.code} bij ${t.isbn} heeft geen kernzin.`);
      naarIndex(kd.code, t.isbn);

      if (!kerndoelen.has(kd.code)) kerndoelen.set(kd.code, { kernzin: kd.kernzin ?? null, subdoelen: {} });
      const cat = kerndoelen.get(kd.code);
      if (cat.kernzin !== (kd.kernzin ?? null)) {
        fouten.push(`Tegenstrijdige kernzin voor ${kd.code} (o.a. bij ${t.isbn}).`);
      }
      for (const sd of kd.subdoelen ?? []) {
        if (!sd.letter) { waarschuwingen.push(`Subdoel zonder letter bij ${kd.code} (${t.isbn}); overgeslagen.`); continue; }
        const zin = sd.doelzin ?? null;
        if (sd.letter in cat.subdoelen && cat.subdoelen[sd.letter] !== zin) {
          fouten.push(`Tegenstrijdige doelzin voor ${kd.code}${sd.letter} (o.a. bij ${t.isbn}).`);
        }
        cat.subdoelen[sd.letter] = zin;
      }
    }
  }

  // Toonregel: een boek raakt aan een doel, het dekt of realiseert er geen.
  const duiding = Object.values(t.duiding ?? {}).join(' ').toLowerCase();
  if (/\bdekt\b|\brealiseert\b/.test(duiding)) toonregelHits.push(`${t.isbn} — ${t.titel}`);

  // dubbel geëncodeerde UTF-8 in de bron
  const platteTekst = [t.titel, t.auteur, t.illustrator, t.flaptekst].filter(Boolean).join(' ');
  if (/\u00c3[\u0080-\u00bf]|\u00e2\u0080/.test(platteTekst)) mojibakeHits.push(`${t.isbn} — ${t.titel} (bv. "${t.auteur}")`);

  const { extra } = woordenschatSamen(t);
  if (extra.length) { woordenschatDivergentie.isbns++; woordenschatDivergentie.extraWoorden += extra.length; }

  niveauFacets(t.niveau, onbekendNiveau);
}

// Zelfde doelcode onder meerdere disciplinelabels: bron-inconsistentie. Niet
// samenvoegen (de discipline staat per blok bij de titel), wel melden.
const dubbeleDisciplines = [...disciplinePerCode]
  .filter(([, set]) => set.size > 1)
  .map(([code, set]) => `${code}: ${[...set].join(' én ')}`);

const woordenschatWees = Object.keys(woordenschatLos).filter((isbn) => !isbnGezien.has(isbn));
if (woordenschatWees.length) waarschuwingen.push(`woordenschat.json bevat ${woordenschatWees.length} ISBN's zonder titel in de bron.`);
if (themacodeSentinels.size) waarschuwingen.push(`Themacode-sentinels uit de bron weggelaten: ${[...themacodeSentinels].join(', ')}.`);
if (!Object.keys(woordenschatLos).length) waarschuwingen.push('source/woordenschat.json(.gz) ontbreekt; alleen het ingebedde woordenschatveld is gebruikt.');
if (!niveauMapping) waarschuwingen.push('source/niveau-mapping.json ontbreekt; `graden` en `leeftijd_min` blijven null.');

/* ---------- harde fouten: stoppen zonder te schrijven ---------- */

if (fouten.length) {
  console.error('\n⛔ De build is gestopt. Er is niets weggeschreven; de bestaande data/ is ongemoeid.\n');
  console.error('Wat er mis is met het overdrachtspakket:\n');
  for (const fout of fouten.slice(0, 40)) console.error(`  • ${fout}`);
  if (fouten.length > 40) console.error(`  • … en nog ${fouten.length - 40} andere.`);
  console.error('\nDit hoort via de redactie en een nieuwe generatie opgelost te worden,');
  console.error('niet door source/ met de hand te wijzigen.\n');
  process.exit(1);
}

/* ---------- stap 2: output opbouwen in het geheugen ---------- */

const index = [];
const coverManifest = new Set();
const themacodes = {};
const titelBestanden = new Map(); // isbn -> json-tekst

for (const t of titels) {
  const cover = coverInfo(t);
  if (cover.lokaal) coverManifest.add(cover.lokaal.replace('covers/', ''));
  const { alles: woordenWolk } = woordenschatSamen(t);
  const themas = themacodesVan(t);
  for (const tc of themas) themacodes[tc.code] = tc.omschrijving ?? null;
  const facets = niveauFacets(t.niveau, new Map());
  const { graden, leeftijd_min } = genormaliseerdNiveau(t);

  // Doelen als code; de uitwerking staat in doelen.json. Wat per titel varieert
  // (redactie, welke subdoelletters) blijft hier staan — en exact zoals de bron het
  // geeft: geen `redactie`-sleutel als de bron die niet heeft, geen `subdoelen`-sleutel
  // als de bron die niet heeft.
  const vlaanderen = (t.vlaanderen ?? []).map((blok) => ({
    discipline: blok.discipline,
    niveau: blok.niveau,
    verantwoording: blok.verantwoording,
    minimumdoelen: (blok.minimumdoelen ?? []).map((md) => ({
      code: md.code,
      ...('redactie' in md ? { redactie: md.redactie } : {}),
    })),
  }));

  const nederland = (t.nederland ?? []).map((blok) => ({
    leergebied: blok.leergebied,
    niveau: blok.niveau,
    verantwoording: blok.verantwoording,
    kerndoelen: (blok.kerndoelen ?? []).map((kd) => ({
      code: kd.code,
      ...('subdoelen' in kd ? { subdoelen: (kd.subdoelen ?? []).map((sd) => sd.letter) } : {}),
      ...('redactie' in kd ? { redactie: kd.redactie } : {}),
    })),
  }));

  const record = { ...t, cover, vlaanderen, nederland, niveau_facets: facets, graden, leeftijd_min };
  record.themacodes = themas;
  if (woordenWolk.length !== (t.woordenschat ?? []).length) record.woordenschat_wolk = woordenWolk;
  delete record.cover_url; // vervangen door het genormaliseerde cover-object
  delete record.voorraad;  // leverbaarheid komt live uit Shopify, niet uit een momentopname
  titelBestanden.set(t.isbn, naarJson(record));

  index.push({
    isbn: t.isbn,
    titel: t.titel,
    reeks: t.reeks || null,
    auteur: t.auteur || null,
    illustrator: t.illustrator || null,
    leeftijd: t.leeftijd || null,
    niveau: t.niveau || null,
    nf: facets,
    graden,
    leeftijd_min,
    cat: t.categorie === 'Speelgoed' ? 'speelgoed' : 'boek',
    cover,
    kv: { h: t.klavertjevier?.hoofdpijler ?? null, p: t.klavertjevier?.pijlers ?? [] },
    status: t.status,
    moeilijk: Boolean(t.mapping_moeilijk),
    kort: t.duiding?.kort ?? null,
    vl: vlaanderen.map((blok) => ({ d: blok.discipline, n: blok.niveau, c: blok.minimumdoelen.map((md) => md.code) })),
    nl: nederland.map((blok) => ({
      lg: blok.leergebied,
      n: blok.niveau,
      kd: blok.kerndoelen.map((kd) => ({ c: kd.code, s: kd.subdoelen ?? [] })),
    })),
    zoek: zoektekst(t, woordenWolk),
  });
}

const doelen = {
  minimumdoelen: Object.fromEntries([...minimumdoelen].sort(([a], [b]) => opCode(a, b))),
  kerndoelen: Object.fromEntries([...kerndoelen].sort(([a], [b]) => opCode(a, b))),
};

const doelenIndexUit = Object.fromEntries(
  [...doelenIndex].sort(([a], [b]) => opCode(a, b)).map(([code, isbns]) => [code, [...isbns].sort()]),
);

const facetwaarden = {
  niveau: NIVEAU_BUCKETS.filter((bucket) => index.some((r) => r.nf.includes(bucket))),
  categorie: [...new Set(index.map((r) => r.cat))].sort(),
  status: Object.keys(perStatus).sort(),
  pijlers: [...new Set(index.flatMap((r) => r.kv.p))].filter(Boolean).sort(),
  disciplines: [...new Set(index.flatMap((r) => r.vl.map((b) => b.d)))].filter(Boolean).sort(),
  leergebieden: [...new Set(index.flatMap((r) => r.nl.map((b) => b.lg)))].filter(Boolean).sort(),
};

/* ---------- stap 3: wegschrijven ---------- */

mkdirSync(TITELS, { recursive: true });

const bestanden = new Map([
  [join(DATA, 'index.json'), naarJson(index)],
  [join(DATA, 'doelen.json'), naarJson(doelen)],
  [join(DATA, 'doelen-index.json'), naarJson(doelenIndexUit)],
  [join(DATA, 'themacodes.json'), naarJson(themacodes)],
  [join(DATA, 'covers-manifest.txt'), `${[...coverManifest].sort().join('\n')}\n`],
]);
for (const [isbn, inhoud] of titelBestanden) bestanden.set(join(TITELS, `${isbn}.json`), inhoud);

// De versie is de inhoudshash van alles hierboven: verandert de data niet, dan
// verandert de versie niet, en dan geeft een regeneratie geen git-diff. De site
// gebruikt hem als cache-buster achter de url's.
//
// Alleen het pad ten opzichte van de repo gaat mee in de hash, nooit het absolute pad.
// Anders hangt de versie af van waar de repo staat en geeft dezelfde data op een
// runner een andere versie dan op een laptop.
const relatief = (pad) => pad.slice(ROOT.length + 1).split(sep).join('/');
const versie = hash(
  [...bestanden]
    .map(([pad, inhoud]) => [relatief(pad), inhoud])
    .sort(([a], [b]) => opCode(a, b))
    .map(([pad, inhoud]) => `${pad}\n${hash(inhoud)}`)
    .join('\n'),
).slice(0, 12);

bestanden.set(join(DATA, 'meta.json'), naarJson({
  versie,
  gegenereerd: bron.gegenereerd ?? null,
  aantal: titels.length,
  doelen: { minimumdoelen: minimumdoelen.size, kerndoelen: kerndoelen.size, indexsleutels: doelenIndex.size },
  facetten: facetwaarden,
}, true));

let ongewijzigd = 0;
for (const [pad, inhoud] of bestanden) {
  // alleen schrijven bij echte wijziging: houdt mtimes en git-diffs eerlijk
  if (existsSync(pad) && readFileSync(pad, 'utf8') === inhoud) { ongewijzigd++; continue; }
  writeFileSync(pad, inhoud);
}

// Opruimen: titels die uit de bron verdwenen zijn.
const verwijderd = [];
for (const naam of existsSync(TITELS) ? readdirSync(TITELS) : []) {
  if (!naam.endsWith('.json')) continue;
  if (!titelBestanden.has(naam.replace(/\.json$/, ''))) {
    rmSync(join(TITELS, naam));
    verwijderd.push(naam);
  }
}

/* ---------- rapport ---------- */

const kb = (pad) => `${Math.round(statSync(pad).size / 1024)} kB`;
const lijst = (arr, max = 12) => arr.slice(0, max).map((x) => `  - ${x}`).join('\n') + (arr.length > max ? `\n  - … (+${arr.length - max})` : '');

const rapport = `# Build datalaag boekenzoeker onderwijs

Bron gegenereerd ${bron.gegenereerd} · ${titels.length} titels · versie \`${versie}\`

## Uitkomst
- ✅ Geen harde fouten: telling klopt, alle sleutels 13-cijferig en uniek, elke titel heeft een titel, geen tegenstrijdige doelteksten.
- \`data/index.json\`: ${kb(join(DATA, 'index.json'))} (${index.length} rijen)
- \`data/doelen.json\`: ${kb(join(DATA, 'doelen.json'))} — ${minimumdoelen.size} minimumdoelen + ${kerndoelen.size} kerndoelen, elk één keer
- \`data/doelen-index.json\`: ${kb(join(DATA, 'doelen-index.json'))} — ${doelenIndex.size} doelcodes (incl. koepelcodes)
- \`data/themacodes.json\`: ${kb(join(DATA, 'themacodes.json'))} — ${Object.keys(themacodes).length} codes
- \`data/titels/\`: ${titelBestanden.size} bestanden${verwijderd.length ? ` (${verwijderd.length} verwijderd: ${verwijderd.slice(0, 5).join(', ')}${verwijderd.length > 5 ? ', …' : ''})` : ''}
- \`data/covers-manifest.txt\`: ${coverManifest.size} covers nodig
- ${ongewijzigd} van ${bestanden.size} bestanden waren al identiek — die zijn niet herschreven.

## Voor team en redactie
${waarschuwingen.length ? waarschuwingen.map((w) => `- ⚠️ ${w}`).join('\n') : '- geen'}
- Zelfde doelcode onder meerdere disciplinelabels (apart gehouden, niet samengevoegd): ${dubbeleDisciplines.length ? `\n${lijst(dubbeleDisciplines, 8)}` : 'geen'}
- Mojibake in de bron: ${mojibakeHits.length ? `\n${lijst(mojibakeHits)}` : 'geen'}
- Duiding met "dekt" of "realiseert" (toonregel): ${toonregelHits.length ? `\n${lijst(toonregelHits)}` : 'geen ✅'}
- Woordenschat: bij ${woordenschatDivergentie.isbns} ISBN's voegt woordenschat.json ${woordenschatDivergentie.extraWoorden} woorden toe die niet in het ingebedde veld staan. De build gebruikt de samenvoeging.

## Let op voor de frontend
- \`voorraad\` en \`leverbaar\` staan **niet** meer in de data — beschikbaarheid komt live uit Shopify.
  Een facet of filter dat op \`leverbaar\` werkt, geeft daarmee nul resultaten en hoort uit de zoeker.
- De doelen in \`data/titels/<isbn>.json\` staan als **code**. De fiche moet ze eerst terugvouwen
  met \`doelen.json\` (doelen-hydratatie.js) voordat er gerenderd wordt.
- Gebruik \`meta.versie\` (\`${versie}\`) als cache-buster; GitHub Pages cachet 10 minuten.

## Tellingen
- Categorie: ${JSON.stringify(perCategorie)}
- Status: ${JSON.stringify(perStatus)}${perStatus.voorstel ? ' — nog niet redactioneel bevestigd; toon dat op de fiche' : ''}
- Herkomst: ${JSON.stringify(perHerkomst)}
- Screeningsbron: ${JSON.stringify(perScreeningsbron)}
- Hoofdpijler Klavertje Vier: ${JSON.stringify(perHoofdpijler)}
- \`mapping_moeilijk\`: ${moeilijk} titels — terughoudender presenteren, met de reden erbij
- Met klasvragen: ${metVragen} · met leerkansen (speelgoed): ${metLeerkansen}

## Covers
- Titels zonder lokale cover: ${coversOntbrekend.length}${coversOntbrekend.length ? `\n${lijst(coversOntbrekend)}` : ' — ✅'}
- Alleen een Magento-placeholder beschikbaar (site toont titeltekst): ${coverPlaceholder.length}${coverPlaceholder.length ? `\n${lijst(coverPlaceholder, 6)}` : ''}
- \`file:///\`-paden in cover_url (nooit als url gebruikt): ${fileUrlCovers.length}

## Doelendekking (leeg is bewust leeg)
- Zonder Vlaams spoor: ${zonderVl.length} · zonder Nederlands spoor: ${zonderNl.length} · zonder beide: ${zonderBeide.length}${zonderBeide.length ? `\n${lijst(zonderBeide)}` : ''}
- Minimumdoel-vermeldingen: ${koepelVermeldingen}; zonder koepelvertaling — GO!: ${koepelLeeg['GO!']}, OVSG: ${koepelLeeg.OVSG}, Op.stap: ${koepelLeeg['Op.stap']}
- Koepeldoelen met een lege \`code\` (wel structuur en label; blijven op de fiche staan, maar zijn niet opzoekbaar) — GO!: ${koepelZonderCode['GO!']}, OVSG: ${koepelZonderCode.OVSG}, Op.stap: ${koepelZonderCode['Op.stap']}

## Niveau
- Niet-gemapte niveau-delen (blijven als ruwe tekst zichtbaar): ${onbekendNiveau.size ? [...onbekendNiveau].map(([k, v]) => `"${k}" (${v}×)`).join(', ') : 'geen'}
`;

console.log(rapport);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, rapport, { flag: 'a' });
