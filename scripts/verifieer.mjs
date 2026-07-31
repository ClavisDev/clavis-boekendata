/**
 * Controleert de gebouwde datalaag tegen de bron.
 *
 * De build haalt de doelen uit de titels en zet ze één keer in doelen.json. Dat mag
 * niets kosten: wie de codes terugvouwt met de catalogus moet exact de structuur
 * terugkrijgen die de bron gaf. Dit script doet die rondrit voor alle titels en
 * vergelijkt veld voor veld.
 *
 * `vouwTitelOpen()` hieronder is meteen de referentie voor doelen-hydratatie.js aan
 * de kant van Instatic: zelfde stappen, zelfde uitkomst.
 *
 * Draait na scripts/build.mjs. Exitcode 1 bij één afwijking.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leesBron } from './bron.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// Objectsleutels sorteren zodat de vergelijking op inhoud gaat en niet op
// sleutelvolgorde; array-orde blijft wél meetellen, die is inhoudelijk.
function canoniek(waarde) {
  if (Array.isArray(waarde)) return waarde.map(canoniek);
  if (waarde && typeof waarde === 'object') {
    const uit = {};
    for (const sleutel of Object.keys(waarde).sort()) uit[sleutel] = canoniek(waarde[sleutel]);
    return uit;
  }
  return waarde;
}
const zelfde = (a, b) => JSON.stringify(canoniek(a)) === JSON.stringify(canoniek(b));

/* ---------- de hydratatie zelf ---------- */

/**
 * Vouwt de doelcodes in een titelrecord terug tot volledige doelen.
 * Muteert `titel` en geeft hem terug — daarna heeft hij de vorm die de rendercode
 * verwacht. Dit is precies wat doelen-hydratatie.js client-side moet doen.
 */
export function vouwTitelOpen(titel, doelen) {
  for (const blok of titel.vlaanderen ?? []) {
    blok.minimumdoelen = (blok.minimumdoelen ?? []).map((verwijzing) => {
      const doel = doelen.minimumdoelen[verwijzing.code];
      if (!doel) throw new Error(`minimumdoel ${verwijzing.code} staat niet in doelen.json`);
      return {
        code: verwijzing.code,
        ankermoment: doel.ankermoment,
        omschrijving: doel.omschrijving,
        koepels: doel.koepels,
        ...('redactie' in verwijzing ? { redactie: verwijzing.redactie } : {}),
      };
    });
  }
  for (const blok of titel.nederland ?? []) {
    blok.kerndoelen = (blok.kerndoelen ?? []).map((verwijzing) => {
      const doel = doelen.kerndoelen[verwijzing.code];
      if (!doel) throw new Error(`kerndoel ${verwijzing.code} staat niet in doelen.json`);
      return {
        code: verwijzing.code,
        kernzin: doel.kernzin,
        // de bron heeft één kerndoel zónder subdoelen-sleutel; dat blijft zo
        ...('subdoelen' in verwijzing
          ? { subdoelen: verwijzing.subdoelen.map((letter) => ({ letter, doelzin: doel.subdoelen[letter] ?? null })) }
          : {}),
        ...('redactie' in verwijzing ? { redactie: verwijzing.redactie } : {}),
      };
    });
  }
  return titel;
}

/* ---------- de controle ---------- */

const bron = leesBron('boekmappings.json');
const doelen = JSON.parse(readFileSync(join(DATA, 'doelen.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8'));
const doelenIndex = JSON.parse(readFileSync(join(DATA, 'doelen-index.json'), 'utf8'));

const afwijkingen = [];
let vlBlokken = 0, nlBlokken = 0, mdDoelen = 0, kdDoelen = 0;

for (const origineel of bron.titels) {
  const pad = join(DATA, 'titels', `${origineel.isbn}.json`);
  if (!existsSync(pad)) { afwijkingen.push(`${origineel.isbn}: geen titelbestand gebouwd`); continue; }
  const opgevouwen = vouwTitelOpen(JSON.parse(readFileSync(pad, 'utf8')), doelen);

  vlBlokken += (origineel.vlaanderen ?? []).length;
  nlBlokken += (origineel.nederland ?? []).length;
  for (const blok of origineel.vlaanderen ?? []) mdDoelen += (blok.minimumdoelen ?? []).length;
  for (const blok of origineel.nederland ?? []) kdDoelen += (blok.kerndoelen ?? []).length;

  if (!zelfde(opgevouwen.vlaanderen ?? [], origineel.vlaanderen ?? [])) {
    afwijkingen.push(`${origineel.isbn} — ${origineel.titel}: Vlaams spoor wijkt af na terugvouwen`);
  }
  if (!zelfde(opgevouwen.nederland ?? [], origineel.nederland ?? [])) {
    afwijkingen.push(`${origineel.isbn} — ${origineel.titel}: Nederlands spoor wijkt af na terugvouwen`);
  }
}

/* ---------- de omgekeerde index moet kloppen met de titels ---------- */

const indexFouten = [];
for (const [code, isbns] of Object.entries(doelenIndex)) {
  if (!code) { indexFouten.push('er staat een lege doelcode in doelen-index.json'); continue; }
  if (!isbns.length) indexFouten.push(`${code} verwijst naar geen enkele titel`);
}
// steekproef andersom: elk minimumdoel van elke titel moet in de index staan
for (const titel of bron.titels) {
  for (const blok of titel.vlaanderen ?? []) {
    for (const md of blok.minimumdoelen ?? []) {
      if (!doelenIndex[md.code]?.includes(titel.isbn)) indexFouten.push(`${titel.isbn} ontbreekt bij ${md.code} in de index`);
    }
  }
}

/* ---------- uitkomst ---------- */

console.log('Rondrit door de hydratatie');
console.log(`  titels vergeleken        : ${bron.titels.length}`);
console.log(`  Vlaamse blokken          : ${vlBlokken} (${mdDoelen} minimumdoel-vermeldingen)`);
console.log(`  Nederlandse blokken      : ${nlBlokken} (${kdDoelen} kerndoel-vermeldingen)`);
console.log(`  catalogus                : ${Object.keys(doelen.minimumdoelen).length} minimumdoelen + ${Object.keys(doelen.kerndoelen).length} kerndoelen`);
console.log(`  omgekeerde index         : ${Object.keys(doelenIndex).length} codes`);
console.log(`  meta.versie              : ${meta.versie}`);
console.log();

if (afwijkingen.length || indexFouten.length) {
  console.error(`⛔ ${afwijkingen.length} afwijking(en) na terugvouwen, ${indexFouten.length} indexfout(en):`);
  for (const regel of [...afwijkingen, ...indexFouten].slice(0, 20)) console.error(`   • ${regel}`);
  process.exit(1);
}

console.log('✅ 0 afwijkingen: terugvouwen geeft exact de bronstructuur terug, en de omgekeerde index klopt.');
