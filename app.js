import {
  classifyValue,
  formatWeekLabel,
  getWeekNumber,
  processWorkerData,
  parseHavvarselJson,
  setDebug,
  THRESHOLDS,
} from './utils.js';

// === KONFIGURASJON ===
const CONFIG = {
  DEBUG: false,
  CACHE_KEY: 'havet_arena_data',
  CACHE_DURATION: 1000 * 60 * 60, // 1 time
  CACHE_VERSION: 9, // v9: delt utils.js-modul
  // Grenseverdiene bor i utils.js (THRESHOLDS) - de deles med workeren.
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  THEME_KEY: 'havet_arena_theme',
  // API URLs - sentralisert for enkel vedlikehold
  URLS: {
    BAKTERIER_WORKER: 'https://bakterier.nytroe.workers.dev/',
    BADING_WORKER: 'https://bading.nytroe.workers.dev/',
    HAVVARSEL_API: 'https://api.havvarsel.no/apis/duapi/havvarsel/v2/temperatureprojection',
    CORS_PROXY: 'https://api.allorigins.win/raw',
    OPEN_METEO: 'https://api.open-meteo.com/v1/forecast',
  },
  // Sentry konfigurasjon - sett din egen DSN her
  SENTRY_DSN:
    'https://0bc32267eafbb1fb9b68fcfaeb23d2a0@o4510692242292736.ingest.de.sentry.io/4510692677386320',
};

let CURRENT_REQUEST_ID = 0;

// Koordinater for Havet Arena, Nyhavna
const LAT = 63.44181;
const LON = 10.42506;

// === SENTRY ERROR TRACKING ===

// Sentry vil bli lastet dynamisk hvis DSN er konfigurert
let sentryLoaded = false;

function initSentry() {
  if (!CONFIG.SENTRY_DSN || sentryLoaded) return;

  const script = document.createElement('script');
  script.src = 'https://browser.sentry-cdn.com/8.42.0/bundle.min.js';
  script.crossOrigin = 'anonymous';
  script.onload = () => {
    if (window.Sentry) {
      window.Sentry.init({
        dsn: CONFIG.SENTRY_DSN,
        environment: window.location.hostname === 'havet.app' ? 'production' : 'development',
        release: `havet-arena@${CONFIG.CACHE_VERSION}`,
        tracesSampleRate: 0.1,
        beforeSend(event) {
          // Ikke send events fra localhost
          if (window.location.hostname === 'localhost') {
            return null;
          }
          return event;
        },
      });
      sentryLoaded = true;
      log('Sentry initialisert');
    }
  };
  script.onerror = () => {
    log('Kunne ikke laste Sentry');
  };
  document.head.appendChild(script);
}

function captureError(error, context = {}) {
  // Logg alltid til console
  console.error('[Havet Arena Error]', error, context);

  // Send til Sentry hvis tilgjengelig
  if (window.Sentry && sentryLoaded) {
    window.Sentry.captureException(error, {
      extra: context,
    });
  }

  // Lagre i localStorage for debugging (hold maks 10 feil)
  try {
    const errorLog = JSON.parse(localStorage.getItem('havet_error_log') || '[]');
    errorLog.unshift({
      timestamp: new Date().toISOString(),
      message: error.message || String(error),
      context,
    });
    localStorage.setItem('havet_error_log', JSON.stringify(errorLog.slice(0, 10)));
  } catch (_e) {
    // Ignorer localStorage-feil (f.eks. i private browsing)
  }
}

function captureMessage(message, level = 'info') {
  if (CONFIG.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[${level.toUpperCase()}]`, message);
  }

  if (window.Sentry && sentryLoaded) {
    window.Sentry.captureMessage(message, level);
  }
}

// === HJELPEFUNKSJONER ===

function log(...args) {
  if (CONFIG.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Tidsavbrudd etter ${timeoutMs / 1000}s mot ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(
  fetchFn,
  maxRetries = CONFIG.RETRY_ATTEMPTS,
  delay = CONFIG.RETRY_DELAY
) {
  let currentDelay = delay;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchFn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      log(`Forsøk ${i + 1} feilet, prøver igjen om ${currentDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= 2;
    }
  }
}

// === VÆRTEMPERATUR (Open-Meteo) ===

async function getTempAtHavetSauna() {
  const url = `${CONFIG.URLS.OPEN_METEO}?latitude=${LAT}&longitude=${LON}&current=temperature_2m&timezone=Europe%2FOslo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const data = await res.json();
  return data?.current?.temperature_2m;
}

async function updateTemperature() {
  try {
    const temp = await getTempAtHavetSauna();
    const tempElement = document.getElementById('temperature');
    const tempValue = document.getElementById('tempValue');

    // Oppdater standard temperatur-visning
    if (tempElement && tempValue && temp !== null && temp !== undefined) {
      tempValue.textContent = Math.round(temp);
      tempElement.style.display = 'flex';
    }

    // Oppdater header temperatur for brutalist-tema
    const headerTempElement = document.getElementById('headerTemperature');
    const headerTempValue = document.getElementById('headerTempValue');
    if (headerTempElement && headerTempValue && temp !== null && temp !== undefined) {
      headerTempValue.textContent = Math.round(temp);
      headerTempElement.style.display = 'inline-flex';
    }
  } catch (error) {
    captureError(error, { source: 'updateTemperature' });
  }
}

// === BADETEMPERATUR (Cloudflare Worker + fallbacks) ===

async function fetchFromWorker() {
  const url = `${CONFIG.URLS.BADING_WORKER}?lat=${LAT}&lon=${LON}`;
  const res = await fetchWithRetry(() =>
    fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
  );
  if (!res.ok) throw new Error(`Worker status: ${res.status}`);

  const data = await res.json();
  const temp = data?.now?.sea_water_temperature;

  if (temp === undefined || temp === null) throw new Error('Ingen temperatur i worker-data');
  return temp;
}

async function fetchFromHavvarselDirect() {
  const url = `${CONFIG.URLS.HAVVARSEL_API}/${LON}/${LAT}`;
  const res = await fetchWithRetry(() =>
    fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
  );
  if (!res.ok) throw new Error(`API status: ${res.status}`);

  const data = await res.json();
  const temp = parseHavvarselJson(data);

  if (temp === undefined || temp === null) throw new Error('Fant ikke temperatur i API-data');
  return temp;
}

async function fetchFromHavvarselProxy() {
  const targetUrl = `${CONFIG.URLS.HAVVARSEL_API}/${LON}/${LAT}`;
  const proxyUrl = `${CONFIG.URLS.CORS_PROXY}?url=${encodeURIComponent(targetUrl)}`;

  const res = await fetchWithRetry(() => fetchWithTimeout(proxyUrl, {}, 10000));
  if (!res.ok) throw new Error(`Proxy status: ${res.status}`);

  const data = await res.json();
  const temp = parseHavvarselJson(data);

  if (temp === undefined || temp === null) throw new Error('Fant ikke temperatur i proxy-data');
  return temp;
}

async function getSeaTemperatureAtHavetArena() {
  const sources = [
    { name: 'Cloudflare Worker', fn: fetchFromWorker },
    { name: 'Havvarsel API', fn: fetchFromHavvarselDirect },
    { name: 'Havvarsel Proxy', fn: fetchFromHavvarselProxy },
  ];

  log('Starter henting av badetemperatur...');

  for (const source of sources) {
    try {
      log(`Prøver kilde: ${source.name}...`);
      const temp = await source.fn();

      if (typeof temp === 'number' && !isNaN(temp)) {
        log(`Suksess med ${source.name}: ${temp}°C`);
        return temp;
      } else {
        log(`${source.name} returnerte ugyldig data:`, temp);
      }
    } catch (error) {
      log(`${source.name} feilet:`, error.message);
    }
  }

  captureMessage('Alle kilder for badetemperatur feilet', 'warning');
  return null;
}

async function updateSeaTemperature() {
  try {
    const temp = await getSeaTemperatureAtHavetArena();
    const seaTempElement = document.getElementById('seaTemperature');
    const seaTempValue = document.getElementById('seaTempValue');

    // Oppdater standard sjøtemperatur-visning
    if (seaTempElement && seaTempValue && temp !== null && temp !== undefined) {
      seaTempValue.textContent = Math.round(temp);
      seaTempElement.style.display = 'flex';
      log('Badetemperatur oppdatert i UI:', Math.round(temp));
    }

    // Oppdater header sjøtemperatur for brutalist-tema
    const headerSeaTempElement = document.getElementById('headerSeaTemperature');
    const headerSeaTempValue = document.getElementById('headerSeaTempValue');
    if (headerSeaTempElement && headerSeaTempValue && temp !== null && temp !== undefined) {
      headerSeaTempValue.textContent = Math.round(temp);
      headerSeaTempElement.style.display = 'inline-flex';
    }
  } catch (error) {
    captureError(error, { source: 'updateSeaTemperature' });
  }
}

// === BAKTERIEDATA (Cloudflare Worker) ===

async function fetchFromBakterierWorker() {
  log('Henter bakteriedata fra Cloudflare Worker:', CONFIG.URLS.BAKTERIER_WORKER);

  const response = await fetchWithRetry(() =>
    fetchWithTimeout(CONFIG.URLS.BAKTERIER_WORKER, {
      method: 'GET',
      mode: 'cors',
      headers: { Accept: 'application/json' },
    })
  );

  if (!response.ok) {
    throw new Error(`Worker HTTP ${response.status}: Kunne ikke hente bakteriedata`);
  }

  const data = await response.json();
  log('Bakteriedata mottatt fra worker:', data);

  if (!data.weeks || Object.keys(data.weeks).length === 0) {
    throw new Error('Ingen ukedata funnet i worker-respons');
  }

  return data;
}

async function fetchSheetData() {
  try {
    log('Henter data fra Cloudflare Worker...');
    const workerData = await fetchFromBakterierWorker();
    return processWorkerData(workerData);
  } catch (error) {
    captureError(error, { source: 'fetchSheetData' });
    throw error;
  }
}

// === UI / VISNING ===

// Vis graf med verdier OG ukenummer
function createMiniChart(historyData = []) {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 140;
  const ctx = canvas.getContext('2d');
  if (!ctx || historyData.length === 0) return canvas;

  const values = historyData.map(h => h.value);
  const weeks = historyData.map(h => h.week);
  const years = historyData.map(h => h.year);

  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const padX = 25;
  const padY = 30; // Mer plass til ukenummer i bunn
  const padTop = 25;
  const span = Math.max(1, maxVal - minVal);

  // Beregn punktposisjoner
  const points = values.map((val, idx) => {
    const x = padX + (idx / Math.max(1, values.length - 1)) * (canvas.width - 2 * padX);
    const yNorm = (val - minVal) / span;
    const y = canvas.height - padY - yNorm * (canvas.height - padY - padTop);
    return { x, y, val, week: weeks[idx], year: years[idx] };
  });

  // Tegn linjen
  ctx.strokeStyle = '#0077b6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((pt, idx) => {
    if (idx === 0) {
      ctx.moveTo(pt.x, pt.y);
    } else {
      ctx.lineTo(pt.x, pt.y);
    }
  });
  ctx.stroke();

  // Tegn punkter, farget etter vannkvalitetsnivå
  const levelColors = { green: '#38ef7d', yellow: '#f5c542', red: '#f45c43' };
  points.forEach(pt => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = levelColors[classifyValue(pt.val).level];
    ctx.strokeStyle = '#0077b6';
    ctx.fill();
    ctx.stroke();
  });

  // Tegn verdier over hvert punkt
  ctx.fillStyle = '#90e0ef';
  ctx.font = '10px Segoe UI';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  points.forEach(pt => {
    ctx.fillText(`${Math.round(pt.val)}`, pt.x, pt.y - 8);
  });

  // Tegn ukenummer under hvert punkt
  ctx.fillStyle = '#90e0ef';
  ctx.font = '11px Segoe UI';
  ctx.textBaseline = 'top';
  points.forEach(pt => {
    ctx.fillText(formatWeekLabel(pt).toLowerCase(), pt.x, canvas.height - 18);
  });

  return canvas;
}

// Bar chart for brutalist tema
function createBarChart(historyData = []) {
  if (!historyData || historyData.length === 0) return null;

  const maxVal = Math.max(...historyData.map(h => h.value), THRESHOLDS.HIGH);

  // Klassifisering -> CSS-klasse på søylen
  const barClass = { green: 'safe', yellow: 'caution', red: 'warning' };

  const container = document.createElement('div');
  container.className = 'graph-bars';

  historyData.forEach(item => {
    const heightPercent = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
    const { level } = classifyValue(item.value);
    const barContainer = document.createElement('div');
    barContainer.className = 'bar-container';
    barContainer.innerHTML = `
      <div class="bar-value">${Math.round(item.value)}</div>
      <div class="bar-wrapper"><div class="bar ${barClass[level]}" style="height: ${Math.max(heightPercent, 8)}%;"></div></div>
      <div class="bar-label">${formatWeekLabel(item)}</div>
    `;
    container.appendChild(barContainer);
  });

  // Legg til legend
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = `
    <div class="legend-item"><div class="legend-color safe"></div><span>God (&lt;${THRESHOLDS.GOOD})</span></div>
    <div class="legend-item"><div class="legend-color caution"></div><span>Mindre god</span></div>
    <div class="legend-item"><div class="legend-color warning"></div><span>Ikke akseptabel (&ge;${THRESHOLDS.HIGH})</span></div>
  `;

  // Returner en wrapper med både bars og legend
  const wrapper = document.createElement('div');
  wrapper.appendChild(container);
  wrapper.appendChild(legend);

  return wrapper;
}

// === TEMA-FUNKSJONALITET ===

function getTheme() {
  try {
    return localStorage.getItem(CONFIG.THEME_KEY) || 'modern';
  } catch (_e) {
    return 'modern';
  }
}

function setTheme(theme) {
  try {
    localStorage.setItem(CONFIG.THEME_KEY, theme);
  } catch (_e) {
    // Ignorer localStorage-feil (f.eks. i private browsing)
  }
  document.body.className = `theme-${theme}`;
  updateThemeToggle();
}

function updateThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    const currentTheme = getTheme();
    toggle.textContent = currentTheme === 'brutalist' ? '🎨 Modern' : '💀 Brutalist';
  }
}

function initTheme() {
  const theme = getTheme();
  document.body.className = `theme-${theme}`;
  updateThemeToggle();
}

function toggleTheme() {
  const currentTheme = getTheme();
  const newTheme = currentTheme === 'brutalist' ? 'modern' : 'brutalist';
  setTheme(newTheme);

  // Re-render graf hvis den finnes
  const historyContainer = document.getElementById('historyChart');
  if (historyContainer && historyContainer.dataset.history) {
    const history = JSON.parse(historyContainer.dataset.history);
    renderChart(history);
  }
}

// Legg til click handler for tema-toggle
function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', toggleTheme);
  }
}

function renderChart(history) {
  const historyContainer = document.getElementById('historyChart');
  if (!historyContainer) return;

  const theme = getTheme();
  historyContainer.innerHTML = '';
  historyContainer.dataset.history = JSON.stringify(history);

  if (history && Array.isArray(history) && history.length > 0) {
    if (theme === 'brutalist') {
      const barChart = createBarChart(history);
      if (barChart) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mini-graph';
        const title = document.createElement('h3');
        title.textContent = 'Siste 5 uker';
        wrapper.appendChild(title);
        wrapper.appendChild(barChart);
        historyContainer.appendChild(wrapper);
      }
    } else {
      const canvas = createMiniChart(history);
      historyContainer.appendChild(canvas);
    }
  }
}

function updateUI(result) {
  const loading = document.getElementById('loading');
  const content = document.getElementById('content');
  const valueDisplay = document.getElementById('valueDisplay');
  const statusText = document.getElementById('statusText');
  const statusTextLabel = document.getElementById('statusTextLabel');
  const statusIconPath = document.getElementById('statusIconPath');
  const weekInfo = document.getElementById('weekInfo');
  const error = document.getElementById('error');

  loading.style.display = 'none';
  error.style.display = 'none';

  let value = null;
  let errorMessage = null;
  let actualWeek = null;
  let actualYear = null;
  let isEstimate = false;
  let rawValue = null;
  let history = null;

  if (typeof result === 'object' && result !== null) {
    value = result.value;
    errorMessage = result.error;
    actualWeek = result.actualWeek;
    actualYear = result.actualYear;
    isEstimate = result.isEstimate;
    rawValue = result.rawValue;
    history = result.history;
  } else {
    value = result;
  }

  if (value === null || isNaN(value)) {
    error.style.display = 'block';
    if (errorMessage) {
      error.textContent = errorMessage;
    } else {
      const { week: currentWeek } = getWeekNumber(new Date());
      error.textContent =
        'Kunne ikke finne verdi for gjeldende uke. Sjekk at dataene har verdier for uke ' +
        currentWeek +
        '.';
    }
    return;
  }

  content.style.display = 'block';

  const currentDate = new Date();
  const { week: currentWeek, year: currentWeekYear } = getWeekNumber(currentDate);

  valueDisplay.textContent = Math.round(value);

  const status = classifyValue(value);

  valueDisplay.className = `value-display ${status.level}`;
  if (statusTextLabel) {
    statusTextLabel.textContent = status.label;
  } else {
    statusText.textContent = status.label;
  }
  if (statusIconPath) {
    statusIconPath.setAttribute('d', status.icon);
  }
  statusText.className = `status-text ${status.level}`;

  const weekToShow = actualWeek ?? currentWeek;
  const yearToShow = actualYear ?? currentWeekYear;

  if (weekToShow !== currentWeek || yearToShow !== currentWeekYear) {
    weekInfo.textContent =
      `Uke ${weekToShow}, ${yearToShow} ` + `(søkte etter uke ${currentWeek}, ${currentWeekYear})`;
  } else {
    weekInfo.textContent = `Uke ${weekToShow}, ${yearToShow}`;
  }

  if (isEstimate && rawValue) {
    weekInfo.textContent += ` — estimert verdi (${rawValue.trim()})`;
  }

  // Oppdater graf med historikk (bruker riktig type basert på tema)
  if (history && Array.isArray(history) && history.length > 0) {
    log('Historikk for graf:', history);
    renderChart(history);
  }
}

// === CACHING ===

async function fetchWithCache() {
  if (CONFIG.DEBUG) {
    log('DEBUG er på – skipper cache og henter ferske data');
    return await fetchSheetData();
  }

  try {
    const cachedRaw = localStorage.getItem(CONFIG.CACHE_KEY);
    if (cachedRaw) {
      const { data, timestamp, version } = JSON.parse(cachedRaw);
      const isFresh = Date.now() - timestamp < CONFIG.CACHE_DURATION;
      const versionOk = version === CONFIG.CACHE_VERSION;
      if (isFresh && versionOk) {
        log('Bruker cached data');
        return data;
      }
      log('Ignorerer cache pga utløpt tid eller versjon');
    }
  } catch (_e) {
    // localStorage kan feile i private browsing eller ved quota-feil
    log('Klarte ikke lese cache - fortsetter uten');
  }

  const data = await fetchSheetData();

  try {
    localStorage.setItem(
      CONFIG.CACHE_KEY,
      JSON.stringify({
        data,
        timestamp: Date.now(),
        version: CONFIG.CACHE_VERSION,
      })
    );
  } catch (_e) {
    // Ignorer skriving hvis localStorage ikke er tilgjengelig
    log('Klarte ikke skrive cache - fortsetter uten');
  }

  return data;
}

// === SERVICE WORKER ===

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // Bruk relativ path for å støtte både localhost og produksjon
    const swPath = window.location.hostname === 'localhost' ? '/sw.js' : '/sw.js';
    navigator.serviceWorker
      .register(swPath)
      .then(_reg => log('Service Worker registrert'))
      .catch(err => {
        // Ikke logg som feil - SW er valgfritt
        log('Service Worker ikke tilgjengelig:', err.message);
      });
  }
}

// === INITIALISERING ===

document.addEventListener('DOMContentLoaded', async () => {
  // La utils.js logge like mye som resten av appen
  setDebug(CONFIG.DEBUG);

  // Initialiser Sentry først (hvis konfigurert)
  initSentry();

  // Initialiser tema og toggle-knapp
  initTheme();
  initThemeToggle();

  // Registrer Service Worker
  registerServiceWorker();

  // Hent temperaturer uavhengig av bakteriedata
  updateTemperature();
  updateSeaTemperature();

  try {
    const myRequestId = ++CURRENT_REQUEST_ID;
    const value = await fetchWithCache();

    if (myRequestId === CURRENT_REQUEST_ID) {
      updateUI(value);
    } else {
      log('Ignorerer utdatert respons (race condition unngått).');
    }
  } catch (error) {
    captureError(error, { source: 'DOMContentLoaded' });
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.style.display = 'block';
      errorEl.textContent = `Kunne ikke hente data: ${error.message}. Prøv å laste siden på nytt.`;
    }
  }
});
