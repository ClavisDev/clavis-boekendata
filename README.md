# Clavis boekendata

De datalaag van de boekenzoeker onderwijs (`onderwijs.uxel.be`). Deze repo bewaart de
onderwijsdata, verwerkt die en serveert het resultaat als statische JSON via GitHub
Pages. Geen server, geen database — dat is een keuze, geen tussenoplossing.

Drie systemen, drie verantwoordelijkheden:

| Systeem | Doet | Doet niet |
|---|---|---|
| **deze repo** | onderwijsdata bewaren, verwerken, serveren | commerce, prijzen, voorraad |
| **Instatic** | de pagina's en de JS die deze JSON ophaalt | data bewaren |
| **Shopify** | catalogus, prijs, beschikbaarheid, cart, checkout | onderwijsdata |

## Wat je wel en niet aanraakt

```
source/    de bron. Komt als geheel van de redactie. NOOIT met de hand wijzigen.
scripts/   de build.
data/      gegenereerd en wegwerpbaar. NOOIT met de hand wijzigen.
covers/    cover-<isbn>.jpg en toy-<ean>.png
```

Een correctie in de data loopt via de redactie en een nieuwe generatie, niet via een
edit hier. Verwijder je `data/`, dan bouwt de volgende run het opnieuw.

## Een nieuwe generatie publiceren

1. Zet het nieuwe `boekmappings.json` gezipt in `source/` (de rauwe bron is 25 MB, gezipt
   2,2 MB — gebruik `gzip -n -9` zodat hergzippen van dezelfde inhoud geen diff geeft).
2. Nieuwe covers erbij in `covers/`.
3. Committen en pushen naar `main`.

De workflow **Datalaag bouwen** doet de rest: bouwen, valideren, `data/` terugcommitten
en een Pages-build aanvragen. Er is ook een handmatige knop onder Actions.

Bij een harde validatiefout — ontbrekend of dubbel ISBN, lege titel, tegenstrijdige
doeltekst — stopt de build, wordt er niets vastgelegd en blijft de gepubliceerde data
staan. De foutmelding staat in gewone taal in het runlog. Een ontbrekende cover of
flaptekst is een waarschuwing, geen fout.

Lokaal hetzelfde doen:

```sh
node scripts/build.mjs      # schrijft data/
node scripts/verifieer.mjs  # controleert de rondrit door de hydratatie
```

## Wat de build oplevert

```
data/meta.json           versie (inhoudshash) + generatiedatum + facetwaarden
data/index.json          1.065 lichte rijen — zoeken, filteren, kaartjes
data/doelen.json         192 minimumdoelen + 29 kerndoelen, elk exact één keer
data/doelen-index.json   3.230 doelcodes -> ISBN's (omgekeerde index, incl. koepelcodes)
data/themacodes.json     413 themacodes -> omschrijving
data/titels/<isbn>.json  volledig detail per titel, doelen als code
data/covers-manifest.txt welke covers de site nodig heeft
```

De build is **idempotent**: twee keer draaien geeft byte-identieke output, want de
objectsleutels worden diep gesorteerd en er staat geen tijdstempel in. Een regeneratie
zonder inhoudelijke wijziging geeft dus geen git-diff, waardoor echte wijzigingen
opvallen.

Waarom niet gewoon de bron serveren: er zijn 192 unieke minimumdoelen, maar hun
koepeluitwerking (GO!, OVSG, Op.stap) staat 59.096 keer herhaald over de titels. De
build zet die één keer apart.

## Voor wie deze data gebruikt

- **De doelen staan als code** in `data/titels/<isbn>.json`. Vouw ze eerst terug met
  `doelen.json` voordat je rendert. `vouwTitelOpen()` in `scripts/verifieer.mjs` is de
  referentie-implementatie; dat script bewijst op alle 1.065 titels dat de rondrit
  exact de bronstructuur teruggeeft.
- **Gebruik `meta.versie` als cache-buster.** Pages zet `Cache-Control: max-age=600`,
  dus haal `meta.json` op met `cache: 'no-store'` en hang `?v=<versie>` achter de rest.
  Zonder dat zie je tot tien minuten na een deploy oude data.
- **Er staat geen voorraad of leverbaarheid in.** Die komt live uit Shopify. Een filter
  dat op `leverbaar` werkt, hoort uit de zoeker.
- **Alle titels staan op `status: "voorstel"`** — nog niet redactioneel bevestigd. Dat
  hoort zichtbaar te zijn op de fiche. 191 titels hebben `mapping_moeilijk` met een
  reden; die reden hoort erbij.
- **Toonregel.** Een boek *raakt aan* een doel of *biedt aanknopingspunten voor*. Het
  dekt, realiseert of voldoet aan niets.
