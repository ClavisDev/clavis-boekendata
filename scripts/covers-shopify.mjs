/**
 * source/shopify-covers.json bijwerken: ISBN -> url van de voorkantcover in Shopify.
 *
 * Waarom een gecommitteerd bestand en niet een call in de build: de build hoort offline
 * te draaien en byte-identieke output te geven (zie README). Een live Shopify-call in
 * build.mjs zou dat op twee manieren breken — de build zou stukgaan als Shopify traag of
 * onbereikbaar is, en de url's dragen een `?v=<stempel>` die verandert zodra iemand een
 * beeld opnieuw uploadt, waardoor elke build een diff geeft zonder inhoudelijke wijziging.
 * Nu is de uitkomst een invoer als elke andere: hij staat in git, je ziet in de diff wat
 * er aan covers verandert, en de build blijft deterministisch.
 *
 * Draaien wanneer er covers bijkomen of veranderen in Shopify:
 *   node scripts/covers-shopify.mjs
 *
 * Daarna `node scripts/build.mjs` (of gewoon committen en pushen — de workflow bouwt).
 *
 * Het Storefront-token is een publiek token: het staat ook client-side in de site en mag
 * hier dus staan. Overschrijven kan met SHOPIFY_DOMEIN / SHOPIFY_STOREFRONT_TOKEN /
 * SHOPIFY_API_VERSIE.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leesBron } from './bron.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOEL = join(ROOT, 'source', 'shopify-covers.json');

const DOMEIN = process.env.SHOPIFY_DOMEIN ?? 'clavis-7753.myshopify.com';
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN ?? '40acdfde9d25f9313c976d9e697de822';
const API_VERSIE = process.env.SHOPIFY_API_VERSIE ?? '2026-01';

// Hoeveel zoekopdrachten in één GraphQL-request. Vijf kost ~185 punten; de Storefront-API
// staat 1000 per request toe, dus dit zit ruim onder de grens en houdt het aantal
// requests (213 voor 1.065 titels) beheersbaar.
const BATCH = 5;

// 480 px hoog is pariteit met covers/: die zijn allemaal 480 hoog. De fiche toont de
// cover op max. 30rem (= 480 px) en een kaartje op ~216 px, dus dit dekt beide. Shopify
// levert op dezelfde url automatisch webp aan browsers die dat in hun Accept-header
// zetten — daardoor is het resultaat lichter dan de jpeg's in covers/ (~39 kB vs 36-78 kB).
const MAX_HOOGTE = 480;

/* ---------- Shopify ---------- */

const PRODUCTVELDEN = `{ edges { node { ... on Product {
  variants(first: 5) { edges { node { sku barcode } } }
  images(first: 8) { edges { node { orig: url, altText, opMaat: url(transform: { maxHeight: ${MAX_HOOGTE} }) } } }
} } } }`;

async function vraagBatch(isbns) {
  const query = `query{${isbns
    .map((isbn, i) => `p${i}: search(query: "${isbn}", first: 3, types: PRODUCT)${PRODUCTVELDEN}`)
    .join(' ')}}`;

  // Vier pogingen met oplopende pauze: de Storefront-API knijpt af op verbruikte punten
  // en een enkele netwerkhik mag een run van 213 requests niet weggooien.
  for (let poging = 1; ; poging++) {
    try {
      const antwoord = await fetch(`https://${DOMEIN}/api/${API_VERSIE}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': TOKEN },
        body: JSON.stringify({ query }),
      });
      if (!antwoord.ok) throw new Error(`HTTP ${antwoord.status}`);
      const json = await antwoord.json();
      if (!json.data) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return json.data;
    } catch (fout) {
      if (poging === 4) throw new Error(`Shopify gaf het op na 4 pogingen (${isbns[0]}…): ${fout.message}`);
      await new Promise((r) => setTimeout(r, 1500 * poging));
    }
  }
}

// De variant moet exact op sku of barcode matchen. `search` matcht ook op titelwoorden,
// dus zonder deze controle zou een gelijknamig ander product de cover kunnen leveren.
function kiesProduct(blok, isbn) {
  for (const { node } of blok?.edges ?? []) {
    const identificatie = new Set();
    for (const { node: variant } of node?.variants?.edges ?? []) {
      if (variant?.sku) identificatie.add(variant.sku);
      if (variant?.barcode) identificatie.add(variant.barcode);
    }
    if (identificatie.has(isbn)) return node;
  }
  return null;
}

/*
 * Niet blind `featuredImage` nemen: bij een reeks titels is het eerste beeld de
 * achterkant (`cover_back`). We kiezen in deze volgorde:
 *
 *   1. een beeld met `cover_front` in de bestandsnaam — zo benoemt de bulkimport ze;
 *   2. het eerste beeld dat géén achterkant is. Dat is een beeld dat iemand met de hand
 *      geüpload heeft (bijvoorbeeld `9789044840308_1.jpg`) en dus de voorkant;
 *   3. anders het eerste beeld: dan heeft Shopify alleen een achterkant, en dat is nog
 *      altijd beter dan een tekstblok. Die titels staan met naam in het rapport, want ze
 *      horen in Shopify opgelost te worden, niet hier.
 *
 * Stap 2 bestaat omdat de positie in Shopify niets belooft. De oudere regel ("anders het
 * eerste beeld") gaf de juiste voorkant zolang die vooraan stond; verschoof iemand de
 * beelden, dan stond de achterkant zonder waarschuwing weer op de site.
 */
const isAchterkant = (beeld) =>
  String(beeld.orig).includes('cover_back') || String(beeld.altText ?? '').trim() === 'cover_back';

function kiesVoorkant(product) {
  const beelden = (product?.images?.edges ?? []).map(({ node }) => node).filter((n) => n?.opMaat);
  if (!beelden.length) return { url: null, reden: 'product-zonder-beeld' };

  const cover_front = beelden.find((n) => String(n.orig).includes('cover_front'));
  if (cover_front) return { url: cover_front.opMaat, reden: 'cover_front' };

  const geenAchterkant = beelden.find((n) => !isAchterkant(n));
  if (geenAchterkant) return { url: geenAchterkant.opMaat, reden: 'ander-beeld' };

  return { url: beelden[0].opMaat, reden: 'alleen-achterkant' };
}

/* ---------- run ---------- */

const bron = leesBron('boekmappings.json', { verplicht: true });
const isbns = (bron.titels ?? []).map((t) => t.isbn).filter(Boolean);
if (!isbns.length) throw new Error('Geen ISBN\'s in de bron gevonden — is source/boekmappings.json compleet?');

const covers = {};
const tellingen = {
  cover_front: 0,
  'ander-beeld': 0,
  'alleen-achterkant': 0,
  'product-zonder-beeld': 0,
  'geen-product': 0,
};
const zonderCover = [];
const alleenAchterkant = [];

for (let start = 0; start < isbns.length; start += BATCH) {
  const groep = isbns.slice(start, start + BATCH);
  const data = await vraagBatch(groep);
  groep.forEach((isbn, i) => {
    const product = kiesProduct(data[`p${i}`], isbn);
    if (!product) {
      tellingen['geen-product']++;
      zonderCover.push(`${isbn} (staat niet in Shopify)`);
      return;
    }
    const { url, reden } = kiesVoorkant(product);
    tellingen[reden]++;
    if (reden === 'alleen-achterkant') alleenAchterkant.push(isbn);
    if (url) covers[isbn] = url;
    else zonderCover.push(`${isbn} (product zonder beeld)`);
  });
  if (start % 250 === 0) process.stderr.write(`  ${Math.min(start + BATCH, isbns.length)}/${isbns.length}\n`);
}

// Sleutels gesorteerd wegschrijven, zodat de diff leesbaar blijft en twee runs zonder
// wijziging in Shopify geen git-ruis geven.
const gesorteerd = {};
for (const isbn of Object.keys(covers).sort()) gesorteerd[isbn] = covers[isbn];
writeFileSync(DOEL, `${JSON.stringify(gesorteerd, null, 2)}\n`);

console.log(`# Shopify-covers

- Titels in de bron: ${isbns.length}
- Met voorkantcover (\`cover_front\`): ${tellingen.cover_front}
- Voorkant onder een eigen bestandsnaam (met de hand geüpload): ${tellingen['ander-beeld']}
- **Alleen een achterkant in Shopify:** ${tellingen['alleen-achterkant']}
- Shopify-product zonder enig beeld: ${tellingen['product-zonder-beeld']}
- Geen Shopify-product op sku/barcode: ${tellingen['geen-product']}
- Weggeschreven naar source/shopify-covers.json: ${Object.keys(gesorteerd).length}
${alleenAchterkant.length ? `\nAlleen een achterkant (${alleenAchterkant.length}) — de site toont dan de rug van het boek.\nEen voorkant in Shopify zetten lost dit op; de volgende synchronisatie pakt hem op:\n${alleenAchterkant.map((r) => `  - ${r}`).join('\n')}` : ''}
${zonderCover.length ? `\nZonder cover (${zonderCover.length}) — dit is een vraag voor het team, niet voor de build:\n${zonderCover.map((r) => `  - ${r}`).join('\n')}` : ''}`);
