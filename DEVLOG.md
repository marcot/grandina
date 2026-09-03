# Grandina — stato dello sviluppo

_Aggiornato: 2026-09-03. Sito live: **https://grandina.dotmark.it** · Repo: [github.com/marcot/grandina](https://github.com/marcot/grandina) · Deploy: Coolify `cooly.dotmark.it`_

## Panoramica

Sistema di previsione grandine basato sui radar della Protezione Civile (Radar-DPC) + AllertaMeteo. Tre componenti in un unico repo TypeScript/ESM (Node 24):

| Componente | Cosa fa | Entrypoint |
|---|---|---|
| **CLI** | `hail` (punto/zona), `alert` (comune), `forecast` (nowcast 0-60/120 min) | `dist/cli.js` (`npm start`) |
| **Libreria** | `hailPredict`, `hailPredictZone`, `nowcastPredict`, `alertForComune` | `dist/index.js` (`import … from 'grandina'`) |
| **Web** | Server Fastify + API JSON + overlay radar PNG in-process + frontend Leaflet mobile-first | `dist/server.js` (`npm run serve`) |

Il runtime è un solo container `node:24-alpine` (Dockerfile 2 stage, porta 3000). Nessun Python a runtime, nessun CDN: Leaflet servito localmente da `node_modules`.

## Storia delle modifiche

| Commit | Data | Contenuto |
|---|---|---|
| `ac3c499` initial | 2026-09-02 | Base: CLI, libreria, download Radar-DPC, geocodifica |
| `d14bf8f` feat: hail nowcasting + LZW warning suppression | 2026-09-02 | Nowcasting 0-60 min (tracker celle VIL, spostamento, 6 orizzonti); fix EOI_CODE stderr; README completo |
| `f034413` feat: TTL frame cache | 2026-09-02 | Cache frame in memoria: 10 min prodotti recenti, 40 min storia VIL; 1 download per finestra di 5 min |
| `34956d0` feat: web server, frontend, docker | 2026-09-02 | Server Fastify + 10 endpoint, overlay renderer (warp TM→3857), frontend Leaflet, Dockerfile, deploy Coolify |
| `c1d9d1f` fix: package.json in runtime image | 2026-09-02 | Crash a boot in prod (`package.json` mancante nel layer runtime) → copia nell'immagine |
| `6158077` docs: web server endpoints | 2026-09-03 | Sezione "Web server" nel README |
| `795327e` feat: GPS + opacità overlay | 2026-09-03 | Geolocalizzazione (auto al load + bottone, marker pulsante); overlay con alpha proporzionale all'intensità; README aggiornato |

## Architettura

### Struttura del codice

```
src/
  predictor.ts    # motore: hailPredict/Zone, nowcastPredict (tracker celle), cache frame TTL
  radar-api.ts    # Radar-DPC (findLastProductByType/downloadProduct), AllertaMeteo, Nominatim
  hail-metrics.ts # soglie scientifiche (POH 0.6/0.8, VIL 20/40/50, ETM 10/12 km, VMI 45/50)
  types.ts        # tipi pubblici (HailPrediction, HailZonePrediction, HailNowcast, …)
  cli.ts          # comando hail/alert/forecast
  format.ts       # output CLI (JSON/testo)
  index.ts        # export libreria
  server.ts       # Fastify: statici + /api/*
  web/
    product-config.ts  # config display per prodotto (range, soglie, colormap, unità)
    colormaps.json     # LUT 256 RGB generati da matplotlib (dev-time, committed)
    projection.ts      # TM custom ↔ WGS84 (proj4) + helper Mercator
    overlay.ts         # warp frame radar → PNG 3857-aligned, cache PNG per prodotto
public/
  index.html app.js style.css   # frontend vanilla + Leaflet
scripts/gen-colormaps.py        # solo dev: rigenera colormaps.json
```

### Fatti tecnici chiave (verificati)

- **Radar-DPC**: `https://radar-api.protezionecivile.it/` (header `Origin: https://radar.protezionecivile.it` obbligatorio). Prodotti POH/VIL/ETM/VMI aggiornati ogni ~5 min. Il download S3 richiede il `time` restituito dal prodotto (non `Date.now()`).
- **Griglia radar**: GeoTIFF 1200×1400 px, 1 km/px, proiezione Transverse Mercator custom (`+proj=tmerc +lat_0=42 +lon_0=12.5 +k=1 +x_0=0 +y_0=0 +datum=WGS84`). Tiepoint (−600 000, 650 000) m; copertura ~5°E-20°E, 35°N-48°N.
- **Encoding valori**: sentinel ≤ −9000 = nodata; ETM nei raster in **metri** (diviso 1000 per km); VMI < 10 dBZ = nessuna ecore (trasparente).
- **Overlay**: warp lato server su griglia di controllo a 8 px (interpolazione bilineare), output in Web Mercator 1 km/px → allineamento esatto con le tile OSM. **Opacità ∝ intensità**: `alpha = 255 · t^0.75` (echi deboli quasi trasparenti, forti pieni); la legenda CSS riflette la stessa rampa.
- **Cache**: frame in memoria 10 min (prodotti recenti) / 40 min (storia VIL nowcast); PNG renderizzati 1 per prodotto fino al cambio timestamp; AllertaMeteo 60 s per comune.

## API (server web)

| Endpoint | Descrizione |
|---|---|
| `GET /health` | Stato + versione (health check Coolify) |
| `GET /api/meta` | Geografia radar + config display (soglie, colormap) |
| `GET /api/products` | Timestamp ultimi prodotti |
| `GET /api/radar/:type` | Overlay PNG dell'ultimo prodotto (`Cache-Control: max-age=300`) |
| `GET /api/zone?lat&lon&radius` | Previsione zona circolare (raggio 1-200 km) |
| `GET /api/hail?lat&lon` | Previsione punto singolo |
| `GET /api/nowcast?lat&lon&radius&hours` | Nowcast 0-60/120 min (6 orizzonti) |
| `GET /api/alert?comune` | AllertaMeteo (cache 60 s) |
| `GET /api/geocode?q` | Comune → lat/lon |
| `GET /api/geocode/reverse?lat&lon` | Lat/lon → comune (Nominatim, `accept-language=it`) |

## Frontend

Mappa Leaflet Italia + OSM, chip prodotti POH/VIL/ETM/VMI con legenda a soglie, ricerca comune, **bottone GPS**:

- al caricamento chiede la posizione (silenziosa se già autorizzata o rifiutata);
- bottone crociera nella riga di ricerca per rilanciare la localizzazione;
- posizione → mappa centrata zoom 10, marker pulsante, pannello del comune (reverse geocoding) con rischio, metriche, avvisi e AllertaMeteo;
- tap su mappa → pannello a foglia (bottom sheet, mobile-first);
- polling prodotti ogni 60 s con indicatore di freschezza;
- GPS opzionale: senza autorizzazione tutto funziona come prima (mappa sull'Italia + ricerca).

## Deploy

- **Coolify**: istanza `cooly-dotmarkit` (cooly.dotmark.it), progetto `grandina`, app `j2r1frocfslbbo123rvsccm0` (Dockerfile, porta 3000, dominio `grandina.dotmark.it`). Token da `~/.config/coolify/config.json` (mai in repo).
- **Auto-deploy**: i webhook non scattano sui repo pubblici senza GitHub App → dopo ogni `git push`:
  `curl -X POST "https://cooly.dotmark.it/api/v1/deploy?uuid=j2r1frocfslbbo123rvsccm0" -H "Authorization: Bearer $COOLIFY_TOKEN"`
- **Tunnel**: la regola Cloudflare wildcard `*.dotmark.it` inoltra all'origine sulla **porta 80**, quindi l'app è servita sull'entrypoint http di Traefik (TLS terminato da Cloudflare). Funziona; per HTTPS diretto in Traefik servirebbe una regola dedicata `grandina.dotmark.it → https://10.219.1.80:443` (pattern filo-rosso).

## Verifiche eseguite (tutte live)

- **Build**: `npx tsc` clean; regressione CLI `hail --comune` integra in ~2 s (cache attivo).
- **Locale (browser)**: overlay dipinto, chip, tap su tempesta reale → pannello completo (POH 61%, VMI 54 dBZ, avvisi, allerta), nowcast 6 orizzonti con vettore di spostamento, ricerca comune, click in mare → degrado pulito.
- **GPS (browser, mock)**: recentering al punto mockato + marker pulsante + pannello del comune reverse-geocodificato, su locale e su **produzione**; rifiuto GPS → nessun crash, nessun messaggio.
- **Overlay alpha (produzione)**: frame VIL quieto → 0 pixel opachi (prima: velo giallo solido su tutta l'area); render sintetico con valori noti → alfa esatti dalla formula (VIL 5→27, 20→76, 40→128, 50→152, 100→255).

## Note operative

1. Repo **pubblico** (scelta per il deploy: API-based deploy dei repo privati richiedeva il wiring del GitHub App su Coolify). Nessun segreto nel repo; se in futuro serve privacy, creare un repo privato + GitHub App su Coolify e replicare l'app.
2. Coolify segnala lo stato app come `running:unknown` (nessun container healthcheck esposto dall'immagine; l'endpoint `/health` funziona comunque e il deploy si verifica lì): `https://grandina.dotmark.it/health` con `uptimeSec` in calo = container nuovo attivo.
3. `radar_animations/` + `create_radar_anim.py`: artefatti demo (Python/matplotlib), esclusi da Docker e da git (`.gitignore`).

## Possibili prossimi passi (non richiesti)

- PWA: manifest + service worker per l'installazione sul telefono.
- Regola Cloudflare dedicata per HTTPS diretto su Traefik (punto Note 1 del tunnel).
- Push notifications / sveglia su rischio alto (escluso per ora: il prodotto è read-only).
- Tracker di test formali (oggi la verifica è end-to-end live; nessuna suite di test nel repo).