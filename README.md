# Grandina

Previsione di grandine dai dati radar della Protezione Civile italiana.

Interroga gli endpoint REST della piattaforma [Radar-DPC](https://dpc-radar.protezionecivile.it/), scarica i prodotti radar rilevanti per la grandine (POH, VIL, ETM, VMI), ne estrae i valori alle coordinate fornite e restituisce una valutazione del rischio basata sulla letteratura scientifica. Integra [AllertaMeteo.app](https://allertameteo.app/) per le allerte ufficiali della Protezione Civile e, con il comando `forecast`, traccia le celle convettive sui frame VIL storici per un nowcasting a 0-60 minuti.

## Installazione

```bash
npm install
npm run build
```

## CLI

### Previsione grandine

Query per coordinate geografiche:

```bash
node dist/cli.js hail --lat 45.4642 --lon 9.1900 --radius 10
```

Query per comune (usa le coordinate del comune):

```bash
node dist/cli.js hail --comune Milano --radius 10
```

Il nome viene geocodificato con Nominatim (OSM). Con `--comune` il comando
stampa anche su stderr l'allerta meteo ufficiale corrente del comune
(`Weather alert: verde`); il risultato (JSON o `--format text`) va su stdout.

### Stato allerta meteo

```bash
node dist/cli.js alert --comune Milano
node dist/cli.js alert --comune Torri di Quartesolo
```

Riporta l'allerta odierna e di domani per categoria (idraulico, temporali,
idrogeologico) più `worstColor`. Supporta nomi di comune multi-parola senza
virgolette:

```bash
node dist/cli.js alert --comune Torri di Quartesolo
```

### Output

JSON strutturato su stdout (default) o testo leggibile con `--format text`.
I messaggi di avanzamento e di stato vanno su stderr, quindi
`node dist/cli.js hail … 2>/dev/null` restituisce solo il risultato pulito:

- **hail**: rischio, confidenza, valori POH/VIL/ETM/VMI (null quando il
  prodotto non copre la zona), statistiche della zona (min/max/mean sui
  campioni nel raggio)
- **alert**: allerta odierna e domani per categoria (idraulico, temporali,
  idrogeologico)
- **forecast**: rischio di base, spostamento della cella e previsioni a
  scadenze di 10 min da 0 a 60 min

```bash
node dist/cli.js hail --lat 45.46 --lon 9.19 --radius 5 --format text
```

### Nowcasting (previsione 0-60 min)

Traccia le celle convettive dai frame VIL storici (a 30 min di distanza) e
ne estrapola la posizione negli orizzonti futuri; l'output include lo
spostamento della cella (`kmPer30min`, direzione, confidenza) e per ogni
scadenza il rischio previsto. Default: `--radius 50`, `--hours 1` (max 2).

```bash
node dist/cli.js forecast --lat 45.46 --lon 9.19 --radius 20 --hours 1
```

## Libreria

```ts
import { hailPredict, hailPredictZone, alertForComune } from 'grandina';

// Previsione per coordinate (punto singolo)
const pred = await hailPredict(45.4642, 9.1900);

// Previsione su una zona circolare di raggio km
const zone = await hailPredictZone(45.4642, 9.1900, 10);

// Allerta per comune
const alert = await alertForComune('Milano');
```

## API Radar-DPC

- Base: `https://radar-api.protezionecivile.it/`
- Richiede header `Origin: https://radar.protezionecivile.it`
- Prodotti per grandine: POH, VIL, ETM, HRD, VMI, LTG
- Documentazione: https://dpc-radar.readthedocs.io/

## Soglie scientifiche

| Metrica | Soglia | Significato |
|---|---|---|
| POH ≥ 0.60 | CSI massimo | Morel & Joss 2004 |
| POH ≥ 0.80 | Match danni assicurativi | |
| VIL > 40 kg/m² | Forte rischio grandine | |
| VIL > 50 kg/m² | Grandine severa | |
| ETM > 10 km | Indicatore grandine | |
| ETM > 12 km | Grandine severa | |
| VMI > 45 dBZ | Forti temporali | |
| VMI > 50 dBZ | Possibile grandine severa | |
