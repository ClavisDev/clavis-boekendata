/**
 * Het inlezen van source/ — gedeeld door build.mjs en verifieer.mjs.
 *
 * Deze code stond eerst in beide scripts apart. Toen de zip-vorm erbij kwam werd maar
 * één van de twee kopieën bijgewerkt, met als gevolg dat de build slaagde en de
 * controle er vlak achter op een ontbrekend bestand stukliep. Daarom staat het hier
 * één keer.
 *
 * De bron mag als .gz, als .zip of plat aangeleverd worden. Ingepakt is nodig omdat de
 * webupload van GitHub bij 25 MB stopt en het rauwe bestand daar net boven zit.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'source');

/*
 * Eén JSON-bestand uit een zip halen, zonder externe pakketten.
 *
 * We lezen de central directory in plaats van de eerste local header, want bij een zip
 * die met een data descriptor is gemaakt staan de groottes in die header op nul. De
 * central directory heeft ze altijd. Entries die macOS erbij zet (__MACOSX/, ._naam)
 * slaan we over.
 */
export function uitZip(buffer, naam) {
  // End of Central Directory achteraan opzoeken (mag een comment achter zich hebben)
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`source/${naam}.zip is geen leesbare zip (geen central directory gevonden).`);

  const aantal = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const kandidaten = [];

  for (let n = 0; n < aantal; n++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const methode = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const naamLengte = buffer.readUInt16LE(pos + 28);
    const extraLengte = buffer.readUInt16LE(pos + 30);
    const commentLengte = buffer.readUInt16LE(pos + 32);
    const lokaalOffset = buffer.readUInt32LE(pos + 42);
    const entryNaam = buffer.toString('utf8', pos + 46, pos + 46 + naamLengte);
    if (!entryNaam.endsWith('/') && !entryNaam.startsWith('__MACOSX/') && !entryNaam.split('/').pop().startsWith('._')) {
      kandidaten.push({ entryNaam, methode, compressed, lokaalOffset });
    }
    pos += 46 + naamLengte + extraLengte + commentLengte;
  }

  const json = kandidaten.filter((k) => k.entryNaam.toLowerCase().endsWith('.json'));
  if (!json.length) {
    throw new Error(`source/${naam}.zip bevat geen .json-bestand (wel: ${kandidaten.map((k) => k.entryNaam).join(', ') || 'niets'}).`);
  }
  if (json.length > 1) {
    throw new Error(`source/${naam}.zip bevat meer dan één .json-bestand (${json.map((k) => k.entryNaam).join(', ')}); zip er precies één in.`);
  }

  const { methode, compressed, lokaalOffset, entryNaam } = json[0];
  if (buffer.readUInt32LE(lokaalOffset) !== 0x04034b50) throw new Error(`source/${naam}.zip: beschadigde ingang voor ${entryNaam}.`);
  const start = lokaalOffset + 30 + buffer.readUInt16LE(lokaalOffset + 26) + buffer.readUInt16LE(lokaalOffset + 28);
  const rauw = buffer.subarray(start, start + compressed);
  if (methode === 0) return rauw;                 // opgeslagen, niet gecomprimeerd
  if (methode === 8) return inflateRawSync(rauw); // deflate, wat zo goed als altijd het geval is
  throw new Error(`source/${naam}.zip gebruikt compressiemethode ${methode}, die we niet lezen. Gebruik een gewone zip of een .gz.`);
}

/**
 * Leest een bronbestand uit source/, in welke van de drie vormen het ook staat.
 *
 * Staan er meerdere vormen naast elkaar, dan stoppen we: dan is niet te zien welke
 * generatie de bedoelde is, en stil de verkeerde publiceren is erger dan niet bouwen.
 */
export function leesBron(naam, { verplicht = false } = {}) {
  const varianten = [
    { pad: join(SOURCE, `${naam}.gz`), lees: (b) => gunzipSync(b) },
    { pad: join(SOURCE, `${naam}.zip`), lees: (b) => uitZip(b, naam) },
    { pad: join(SOURCE, naam), lees: (b) => b },
  ].filter((v) => existsSync(v.pad));

  if (varianten.length > 1) {
    console.error(`\n⛔ Er staan meerdere versies van ${naam} in source/:\n`);
    for (const v of varianten) console.error(`     ${v.pad.slice(SOURCE.length + 1)}`);
    console.error(`\n   Zo is niet te zeggen welke de bedoelde generatie is. Laat er één staan.\n`);
    process.exit(1);
  }

  if (varianten.length === 1) {
    const [{ pad, lees }] = varianten;
    try {
      return JSON.parse(lees(readFileSync(pad)).toString('utf8'));
    } catch (fout) {
      console.error(`\n⛔ ${pad.slice(SOURCE.length + 1)} kon niet gelezen worden:\n`);
      console.error(`     ${fout.message}\n`);
      process.exit(1);
    }
  }

  if (verplicht) {
    console.error(`\n⛔ source/${naam} ontbreekt (als .gz, .zip of plat). Dit is de bron van de`);
    console.error(`   hele datalaag; zonder dat bestand valt er niets te bouwen. Vraag de redactie`);
    console.error(`   om een nieuw overdrachtspakket en zet het bestand in source/.\n`);
    process.exit(1);
  }
  return null;
}
