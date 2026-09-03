/* Grandina web frontend — vanilla JS + Leaflet. */
'use strict';

const PRODUCTS = ['POH', 'VIL', 'ETM', 'VMI'];

const RISK_LABELS = {
  none: 'Nessun rischio',
  low: 'Rischio basso',
  medium: 'Rischio moderato',
  high: 'Rischio alto',
  extreme: 'Rischio estremo',
};
const RISK_COLORS = {
  none: '#4ade80',
  low: '#fbbf24',
  medium: '#fb923c',
  high: '#f43f5e',
  extreme: '#c026d3',
};
const PROD_SHORT = {
  POH: ['POH', 'prob. grandine'],
  VIL: ['VIL', 'acqua in quota'],
  ETM: ['ETM', 'altezza eco'],
  VMI: ['VMI', 'intensità'],
};
// API colore values arrive in Italian (giallo/arancione/rosso/verde); keep
// both spellings so worstColor/colore always resolve.
const ALERT_COLOR_CSS = { verde: '#4ade80', green: '#4ade80', giallo: '#fde047', yellow: '#fde047', arancione: '#fb923c', orange: '#fb923c', rosso: '#ef4444', red: '#ef4444' };
const ALERT_COLOR_LABEL = { verde: 'Verde', green: 'Verde', giallo: 'Gialla', yellow: 'Gialla', arancione: 'Arancione', orange: 'Arancione', rosso: 'Rossa', red: 'Rossa' };
const DIR_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

const $ = (id) => document.getElementById(id);
const mapEl = $('map');
const panel = $('panel');
const panelBody = $('panelBody');
const panelToggle = $('panelToggle');
const chipsEl = $('chips');
const legendEl = $('legend');
const staleDot = $('staleDot');
const staleText = $('staleText');
const searchForm = $('search');
const searchInput = $('q');
const searchMsg = $('searchMsg');

const state = {
  meta: null,
  active: 'VIL',
  overlay: null,
  overlayBounds: null,
  products: {},
  marker: null,
  seq: 0,
  lastPoint: null,
};

/* ---------- tiny helpers ---------- */

async function api(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Errore ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
function minAgo(ms) {
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function directionLabel(deg) {
  const idx = Math.round(deg / 45) % 8;
  return DIR_LABELS[idx < 0 ? idx + 8 : idx];
}

/* ---------- topbar / products ---------- */

function setStale(ms) {
  const newest = Math.max(...Object.values(state.products).map((p) => p.time).filter((t) => t !== null), 0);
  if (!newest) {
    staleDot.className = 'dot bad';
    staleText.textContent = 'dati non disponibili';
    return;
  }
  const age = minAgo(newest);
  staleDot.className = 'dot ' + (age > 15 ? 'bad' : age > 5 ? 'warn' : 'ok');
  staleText.textContent = age > 15 ? `dati non aggiornati (${age} min)` : `aggiornato ${fmtClock(newest)}`;
}

async function refreshProducts(first) {
  try {
    state.products = await api('/api/products');
  } catch { /* next tick */ }
  if (!state.products || typeof state.products[state.active] !== 'object') return;
  setStale(Date.now());
  const t = state.products[state.active].time;
  if (t && (!state.overlayTs || state.overlayTs !== t)) {
    loadOverlay(state.active, t);
  } else if (first) {
    loadOverlay(state.active, t);
  }
}

function loadOverlay(type, ts) {
  if (!state.overlayBounds) return;
  if (state.overlay) map.removeLayer(state.overlay);
  const url = `/api/radar/${type}` + (ts ? `?t=${ts}` : '');
  state.overlay = L.imageOverlay(url, state.overlayBounds, { opacity: 0.75, interactive: false });
  state.overlay.addTo(map);
  state.overlayTs = ts;
}

/* ---------- chips & legend ---------- */

// Stessa rampa di opacità dell'overlay server-side: alpha = 255 * t^0.75
// (valori deboli quasi trasparenti, valori forti pieni).
function hexRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

function gradientCss(stops) {
  const n = stops.length;
  return `linear-gradient(90deg, ${stops
    .map((c, i) => {
      const t = i / (n - 1);
      return `${hexRgba(c, Math.round(255 * Math.pow(t, 0.75)))} ${(t * 100)}%`;
    })
    .join(', ')})`;
}

function buildControls() {
  chipsEl.innerHTML = '';
  for (const t of PRODUCTS) {
    const [code, label] = PROD_SHORT[t];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (t === state.active ? ' active' : '');
    btn.innerHTML = `${code}<small>${label}</small>`;
    btn.addEventListener('click', () => {
      state.active = t;
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      renderLegend(t);
      const prod = state.products[t];
      loadOverlay(t, prod && prod.time ? prod.time : null);
    });
    chipsEl.appendChild(btn);
  }
  renderLegend(state.active);
}

function renderLegend(type) {
  const meta = state.meta;
  if (!meta) return;
  const cfg = meta.products[type];
  legendEl.classList.add('show');
  const pct = (v) => Math.max(0, Math.min(1, (v - cfg.vmin) / (cfg.vmax - cfg.vmin)));
  legendEl.innerHTML = `
    <div class="legend-bar" style="background:${gradientCss(cfg.stops)}"></div>
    <div class="legend-scale">
      <span class="edge-left">${formatMetric(cfg.vmin, type)}</span>
      <span style="left:${(pct(cfg.high) * 100).toFixed(0)}%">${formatMetric(cfg.high, type)}</span>
      <span style="left:${(pct(cfg.extreme) * 100).toFixed(0)}%">${formatMetric(cfg.extreme, type)}</span>
      <span class="edge-right">${formatMetric(cfg.vmax, type)}</span>
    </div>`;
}

function formatMetric(v, type) {
  if (v === null || v === undefined) return '—';
  switch (type) {
    case 'POH': return Math.round(v * 100) + '%';
    case 'VIL': return v.toFixed(1) + ' kg/m²';
    case 'ETM': return (v / 1000).toFixed(1) + ' km';
    case 'VMI': return Math.round(v) + ' dBZ';
    default: return String(v);
  }
}

/* ---------- panel ---------- */

panelToggle.addEventListener('click', () => {
  panel.classList.toggle('closed');
});

function openPanel() {
  panel.classList.remove('closed');
}

function panelLoading() {
  panelBody.innerHTML = '<div class="panel-loading">Analisi radar in corso…</div>';
  openPanel();
}
function panelError(msg) {
  panelBody.innerHTML = `<div class="panel-error">${esc(msg)}</div>`;
  openPanel();
}

function translateWarning(w) {
  const map = [
    [/no significant hail activity/i, 'Nessuna attività grandinigena significativa nell’area'],
    [/POH data unavailable for this location/i, 'Dato POH non disponibile per questa posizione'],
    [/VIL data unavailable for this location/i, 'Dato VIL non disponibile per questa posizione'],
    [/ETM data unavailable for this location/i, 'Dato ETM non disponibile per questa posizione'],
    [/no radar data available for this location/i, 'Nessun dato radar disponibile per questa posizione'],
    [/no radar data available for nowcasting/i, 'Nessun dato radar disponibile per il nowcasting'],
    [/high echo top detected but VIL is low/i, 'Eco molto alto ma VIL basso: possibile microburst o incudine'],
    [/high reflectivity with low POH/i, 'Riflettività alta con POH basso: possibile pioggia intensa senza grandine'],
    [/data may be stale/i, 'I dati radar potrebbero non essere aggiornati'],
    [/tracking could not be established/i, 'Tracciamento celle non disponibile'],
  ];
  for (const [re, it] of map) if (re.test(w)) return it;
  return w;
}

function metricCard(name, type, stat, cfg) {
  const norm = stat !== null && type === 'ETM' ? stat / 1000 : stat; // raster ETM is meters
  const hot = cfg && norm !== null && norm >= cfg.high;
  return `<div class="metric${hot ? ' hot' : ''}">
    <div class="name">${name}</div>
    <div class="value">${formatMetric(stat, type)}</div>
  </div>`;
}

function renderZone(z, comune) {
  const risk = z.risk;
  const cfg = (t) => state.meta && state.meta.products[t];
  const st = z.stats;
  const when = z.nearestTimestamp
    ? `radar delle ${fmtClock(z.nearestTimestamp)} (${minAgo(z.nearestTimestamp)} min fa)`
    : 'timestamp radar non disponibile';
  const loc = comune || `Punto selezionato`;
  const sub = `${z.centerLat.toFixed(4)}°, ${z.centerLon.toFixed(4)}° · raggio ${z.radiusKm} km · ${z.samples} campioni`;
  const cards = `
    ${metricCard('POH', 'POH', st.poH.max, cfg('POH'))}
    ${metricCard('VIL', 'VIL', st.vil.max, cfg('VIL'))}
    ${metricCard('ETM', 'ETM', st.etm ? st.etm.max : null, cfg('ETM'))}
    ${metricCard('VMI', 'VMI', st.vmi ? st.vmi.max : null, cfg('VMI'))}`;
  const warnings = (z.warnings || []).map(translateWarning);
  panelBody.innerHTML = `
    <div class="loc">
      <h2>${esc(loc)}</h2>
      <div class="coord">${sub}</div>
    </div>
    <div class="riskrow">
      <span class="badge" style="color:#0b1220;background:${RISK_COLORS[risk]}">${RISK_LABELS[risk]}</span>
      <span class="conf">confidenza ${Math.round((z.confidence || 0) * 100)}%</span>
    </div>
    <div class="metrics">${cards}</div>
    <div class="tsline">${when}</div>
    ${warnings.length ? `<ul class="warnlist">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <button id="nowcastBtn" class="btn">Previsione 0–60 min</button>
    <div id="alertSlot"></div>
    <footer class="src">Fonte dati: radar nazionale DPC · allerta meteo AllertaMeteo. Previsione sperimentale: non sostituisce i bollettini ufficiali.</footer>`;
  $('nowcastBtn').addEventListener('click', async () => {
    const btn = $('nowcastBtn');
    btn.disabled = true;
    btn.textContent = 'Calcolo nowcasting…';
    try {
      const nc = await api(`/api/nowcast?lat=${z.centerLat}&lon=${z.centerLon}&radius=${z.radiusKm}&hours=1`);
      renderNowcast(nc);
    } catch (e) {
      panelBody.insertAdjacentHTML('beforeend', `<div class="panel-error">${esc(e.message)}</div>`);
    } finally {
      btn.remove();
    }
  });
  if (comune) fetchAlert(comune, z);
}

function renderNowcast(nc) {
  const d = nc.displacement || {};
  const dirTxt = d.degrees !== undefined && d.degrees !== null
    ? `${directionLabel(d.degrees)} (${Math.round(d.degrees)}°)`
    : '—';
  const chips = (nc.forecasts || []).map((f) => `
    <div class="nc-chip">
      <span class="t">${f.minutesFromNow} min</span>
      <span class="lvl" style="color:${RISK_COLORS[f.risk]}">${RISK_LABELS[f.risk].replace(/^Rischio /, '')}</span>
    </div>`).join('');
  panelBody.insertAdjacentHTML('beforeend', `
    <div class="nowcast-area show">
      <div class="nowcast-head">Previsione 0–60 min</div>
      <div class="nc-chips">${chips || '<span class="panel-error">nessuna previsione</span>'}</div>
      <div class="nc-note">Spostamento celle: ${d.kmPer30min ? d.kmPer30min.toFixed(1) + ' km/30min' : 'n.d.'} verso ${dirTxt} · confidenza ${Math.round((d.confidence || 0) * 100)}%</div>
      ${(nc.warnings || []).map((w) => `<ul class="warnlist"><li>${esc(translateWarning(w))}</li></ul>`).join('')}
    </div>`);
}

async function fetchAlert(comune, z) {
  const slot = $('alertSlot');
  if (!slot) return;
  try {
    const alert = await api(`/api/alert?comune=${encodeURIComponent(comune)}`);
    renderAlert(slot, alert);
  } catch {
    slot.innerHTML = '';
  }
}

function renderAlert(slot, alert) {
  const worst = String(alert.worstColor || 'verde').toLowerCase();
  const dayBlock = (title, day) => {
    if (!day) return '';
    const col = day.allerta && day.allerta.colore ? String(day.allerta.colore).toLowerCase() : 'verde';
    const bg = ALERT_COLOR_CSS[col] || ALERT_COLOR_CSS.green;
    const rows = [
      ['Idraulico', day.dettagli && day.dettagli.idraulico],
      ['Temporali', day.dettagli && day.dettagli.temporali],
      ['Idrogeologico', day.dettagli && day.dettagli.idrogeologico],
    ].filter(([, v]) => v);
    return `<div class="alert-day">
      <div class="day-name"><span>${title}</span>
        <span class="alert-chip" style="background:${bg}">${ALERT_COLOR_LABEL[col] || col}</span>
      </div>
      ${day.allerta && day.allerta.descrizione ? `<div class="dlabel">${esc(day.allerta.descrizione)}</div>` : ''}
      ${rows.map(([k, v]) => `<div class="alert-row"><span>${k}</span><span>${esc(v)}</span></div>`).join('')}
    </div>`;
  };
  slot.innerHTML = `<div class="alert-block">
    <header>
      <span>Allerta meteo · ${esc(alert.comune)}</span>
      <span class="alert-chip" style="background:${ALERT_COLOR_CSS[worst]}">${ALERT_COLOR_LABEL[worst] || worst}</span>
    </header>
    ${dayBlock('Oggi', alert.today)}
    ${dayBlock('Domani', alert.tomorrow)}
  </div>`;
}

/* ---------- queries ---------- */

async function pickPoint(lat, lon) {
  state.lastPoint = { lat, lon };
  if (state.marker) map.removeLayer(state.marker);
  const icon = L.divIcon({ className: '', html: '<div class="map-marker"><span></span></div>', iconSize: [16, 16], iconAnchor: [8, 16] });
  state.marker = L.marker([lat, lon], { icon }).addTo(map);
  panelLoading();
  let comune = null;
  const mySeq = ++state.seq;
  const [zoneRes, revRes] = await Promise.allSettled([
    api(`/api/zone?lat=${lat}&lon=${lon}&radius=10`),
    api(`/api/geocode/reverse?lat=${lat}&lon=${lon}`),
  ]);
  if (mySeq !== state.seq) return;
  if (zoneRes.status === 'fulfilled') {
    comune = revRes.status === 'fulfilled' && revRes.value.comune ? revRes.value.comune : null;
    renderZone(zoneRes.value, comune);
  } else {
    panelError(zoneRes.reason.message);
  }
}

/* ---------- geolocalizzazione ---------- */

let userMarker = null;

function showSearchMsg(msg) {
  searchMsg.textContent = msg;
  searchMsg.classList.add('show');
  setTimeout(() => searchMsg.classList.remove('show'), 4000);
}

function locateUser(showErrors) {
  const btn = $('gpsBtn');
  if (!('geolocation' in navigator)) {
    if (showErrors) showSearchMsg('GPS non disponibile su questo dispositivo');
    return;
  }
  btn.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('busy');
      const { latitude: lat, longitude: lon } = pos.coords;
      if (!userMarker) {
        userMarker = L.marker([lat, lon], {
          interactive: false,
          icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(map);
      } else {
        userMarker.setLatLng([lat, lon]);
      }
      map.setView([lat, lon], 10, { animate: false });
      pickPoint(lat, lon);
    },
    (err) => {
      btn.classList.remove('busy');
      if (!showErrors) return;
      const msg =
        err.code === 1 ? 'Accesso alla posizione negato'
        : err.code === 2 ? 'Posizione non disponibile'
        : 'Rilascio della posizione scaduto';
      showSearchMsg(msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
}

const gpsBtn = $('gpsBtn');
gpsBtn.addEventListener('click', () => locateUser(true));

searchForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = searchInput.value.trim();
  searchMsg.classList.remove('show');
  if (!q) return;
  try {
    const g = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    map.setView([g.lat, g.lon], 10, { animate: false });
    pickPoint(g.lat, g.lon);
  } catch {
    showSearchMsg('Comune non trovato');
  }
});

async function init() {
  try {
    state.meta = await api('/api/meta');
    const b = state.meta.radarBounds;
    state.overlayBounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
  } catch {
    panelError('Impossibile caricare la configurazione radar');
    return;
  }

  window.map = L.map('map', {
    center: [42.5, 12.5],
    zoom: 6,
    minZoom: 5,
    maxZoom: 13,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('Radar: <a href="https://radar.protezionecivile.it/">DPC</a>');
  map.on('click', (e) => pickPoint(e.latlng.lat, e.latlng.lng));

  buildControls();
  try {
    state.products = await api('/api/products');
  } catch { state.products = {}; }
  setStale(Date.now());
  loadOverlay(state.active, state.products[state.active] ? state.products[state.active].time : null);
  setInterval(refreshProducts, 60000);
  locateUser(false); // chiedi la posizione (prompt solo se non già autorizzata)
}

init();
