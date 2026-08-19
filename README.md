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
covers/    cover-<isbn>.jpg en toy-<ean>.png — de oude coverbron, nu reserve (zie Covers)
```

Eén uitzondering op "source/ komt van de redactie": `source/shopify-covers.json` komt niet
van de redactie maar uit Shopify, en wordt door een script geschreven — niet met de hand.
Zie [Covers](#covers).

Een correctie in de data loopt via de redactie en een nieuwe generatie, niet via een
edit hier. Verwijder je `data/`, dan bouwt de volgende run het opnieuw.

## Een nieuwe generatie publiceren

1. Zet het nieuwe `boekmappings.json` **ingepakt** in `source/`. Inpakken is nodig omdat
   de webupload van GitHub bij 25 MB stopt en de rauwe bron daar net boven zit (25 MB,
   ingepakt ruim 2 MB). Drie vormen mogen:

   | Bestand | Hoe je die maakt |
   |---|---|
   | `source/boekmappings.json.zip` | rechtsklik → *Comprimeer* (macOS) of *Zip* (Windows) |
   | `source/boekmappings.json.gz` | `gzip -n -9 -c boekmappings.json > boekmappings.json.gz` |
   | `source/boekmappings.json` | alleen via `git push`, niet via de webupload |

   Bij een zip hoort er precies één `.json` in te zitten; `__MACOSX`-ruis van macOS wordt
   genegeerd. Zet er nooit twee vormen naast elkaar — dan stopt de build, omdat niet te
   zien is welke generatie de bedoelde is.

2. Covers hoef je niet aan te raken: die komen uit Shopify en worden elke nacht
   gesynchroniseerd (zie [Covers](#covers)). `covers/` hoeft niet meer bijgewerkt te worden.
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

## Covers

De site toont **de cover uit Shopify** (`cover.shopify`). Dat is een bewuste keuze van
13 augustus 2026: Shopify is de plek waar de covers onderhouden worden, dus daar staan ze
compleet en actueel. De keerzijde staat hieronder — 117 titels hebben er geen beeld.

**Dit gaat automatisch.** De workflow **Shopify-covers synchroniseren** draait elke nacht
om 04:30 UTC: hij haalt de covers op, en alléén als er iets veranderd is legt hij
`source/shopify-covers.json` vast en laat hij de datalaag opnieuw bouwen. Zet iemand vandaag
een cover in Shopify, dan staat hij morgen op de site. Wil je niet wachten: Actions >
Shopify-covers synchroniseren > Run workflow. Met de hand kan ook nog:

```sh
node scripts/covers-shopify.mjs   # schrijft source/shopify-covers.json
node scripts/build.mjs            # zet ze in cover.shopify
```

Waarom een gecommitteerd bestand en geen call in de build: de build hoort offline te draaien
en byte-identiek te zijn, en de Shopify-url's dragen een `?v=`-stempel die verandert zodra
iemand een beeld opnieuw uploadt. Nu zie je in de git-diff precies welke covers wijzigen, en
praat er één workflow naar buiten in plaats van elke build.

Welk beeld van een product de cover wordt, in deze volgorde: een bestandsnaam met
`cover_front`; anders het eerste beeld dat geen achterkant is (met de hand geüploade
voorkanten heten bijvoorbeeld `9789044840308_1.jpg`); anders de achterkant, want die is nog
altijd beter dan een tekstblok. Op de positie in Shopify vertrouwen we niet — beelden
verschuiven daar.

Stand op 19 augustus 2026 — het rapport van de synchronisatie telt dit elke run opnieuw:

| | Titels |
|---|---|
| Voorkantcover (`cover_front`) uit Shopify | 938 |
| Voorkant onder een eigen bestandsnaam, met de hand geüpload | 10 |
| Alleen een achterkant → **de rug van het boek op de site** | 0 |
| Shopify-product zonder enig beeld → **tekstblok op de site** | 95 |
| Geen Shopify-product op sku/barcode → **tekstblok op de site** | 22 |

Die laatste drie groepen zijn een vraag voor het team, niet voor deze repo: een ontbrekend
of verkeerd beeld hoort in Shopify opgelost te worden, en de eerstvolgende nacht pikt de
synchronisatie het op. Het rapport noemt ze bij ISBN.

De url's vragen `maxHeight: 480` op — pariteit met `covers/`, en Shopify levert op dezelfde
url automatisch webp aan browsers die dat aankunnen (~39 kB in plaats van ~84 kB jpeg).

`covers/` en `cover.cdn` blijven staan als reserve en als terugweg: ze zijn nog compleet
voor 850 titels, dus één regel in `coverBronnen()` in de site brengt ze terug.

## Voor wie deze data gebruikt

- **De doelen staan als code** in `data/titels/<isbn>.json`. Vouw ze eerst terug met
  `doelen.json` voordat je rendert. `vouwTitelOpen()` in `scripts/verifieer.mjs` is de
  referentie-implementatie; dat script bewijst op alle 1.065 titels dat de rondrit
  exact de bronstructuur teruggeeft.
- **Gebruik `meta.versie` als cache-buster.** Pages zet `Cache-Control: max-age=600`,
  dus haal `meta.json` op met `cache: 'no-store'` en hang `?v=<versie>` achter de rest.
  Zonder dat zie je tot tien minuten na een deploy oude data.
- **Gebruik `cover.shopify`.** Dat is de cover die de site toont. `cover.lokaal` (pad binnen
  deze repo) en `cover.cdn` (Magento) staan er nog als reserve; `cdn` levert voor 215 titels
  een placeholder van 262×262, dus wie die alsnog gebruikt moet daarop controleren.
- **Er staat geen voorraad of leverbaarheid in.** Die komt live uit Shopify. Een filter
  dat op `leverbaar` werkt, hoort uit de zoeker.
- **Alle titels staan op `status: "voorstel"`** — nog niet redactioneel bevestigd. Dat
  hoort zichtbaar te zijn op de fiche. 191 titels hebben `mapping_moeilijk` met een
  reden; die reden hoort erbij.
- **Toonregel.** Een boek *raakt aan* een doel of *biedt aanknopingspunten voor*. Het
  dekt, realiseert of voldoet aan niets.
