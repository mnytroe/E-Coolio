// === KONFIGURASJON ===
const CONFIG = {
  DEBUG: false,
  CACHE_KEY: 'havet_arena_data',
  CACHE_DURATION: 1000 * 60 * 60, // 1 time
  CACHE_VERSION: 8, // v8: årstall i datasettet, tredelt grenseverdi
  // Grenseverdier for E. coli (CFU/100 ml).
  // Kilde: Helsedirektoratets vannkvalitetsnormer for friluftsbad.
  //   < 100  -> God
  //   100-999 -> Mindre god
  //   >= 1000 -> Ikke akseptabel
  THRESHOLD_GOOD: 100,
  THRESHOLD_HIGH: 1000,
  // Trondheim kommunes grense for å ta oppfølgingsprøve (vises som merknad).
  THRESHOLD_FOLLOWUP: 500,
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

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week: weekNum, year: d.getUTCFullYear() };
}

// Sammenlignbart løpenummer for (år, uke) slik at uker kan sorteres på tvers av årsskiftet.
function weekOrdinal(year, week) {
  return year * 100 + week;
}

// Kort ukelabel til grafene. Årstall vises kun når målingen er fra et annet år
// enn inneværende, slik at januar-fallback til fjoråret ikke blir forvirrende.
function formatWeekLabel({ week, year }) {
  const currentYear = getWeekNumber(new Date()).year;
  return year && year !== currentYear ? `Uke ${week} · ${year}` : `Uke ${week}`;
}

// === GRENSEVERDIER ===

// SVG-paths for statusikonene
const ICON_PATHS = {
  success:
    'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z',
  caution:
    'M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12 6a.75.75 0 01.75.75v5.5a.75.75 0 01-1.5 0v-5.5A.75.75 0 0112 6zm0 10.5a.9.9 0 110 1.8.9.9 0 010-1.8z',
  warning:
    'M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.75c1.155 2-.289 4.5-2.598 4.5H4.644c-2.309 0-3.752-2.5-2.598-4.5L9.401 3.003zM12 8.25a.75.75 0 00-.75.75v3a.75.75 0 001.5 0v-3a.75.75 0 00-.75-.75zm0 6a.75.75 0 100 1.5.75.75 0 000-1.5z',
};

/**
 * Klassifiserer en E. coli-verdi etter Helsedirektoratets vannkvalitetsnormer
 * for friluftsbad. Returnerer nivå, brukervendt tekst og hvilket ikon som skal vises.
 */
function classifyValue(value) {
  if (value >= CONFIG.THRESHOLD_HIGH) {
    return {
      level: 'red',
      label: 'Ikke akseptabel – ikke anbefalt for bading',
      icon: ICON_PATHS.warning,
    };
  }

  if (value >= CONFIG.THRESHOLD_GOOD) {
    const needsFollowUp = value >= CONFIG.THRESHOLD_FOLLOWUP;
    return {
      level: 'yellow',
      label: needsFollowUp
        ? 'Mindre god – over grensen for oppfølgingsprøve'
        : 'Mindre god – bad med forbehold',
      icon: ICON_PATHS.caution,
    };
  }

  return {
    level: 'green',
    label: 'God – trygt for bading',
    icon: ICON_PATHS.success,
  };
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

function parseHavvarselJson(data) {
  if (!data) return null;

  if (data.variables && Array.isArray(data.variables) && data.variables.length > 0) {
    const variable = data.variables[0];
    if (variable.data && Array.isArray(variable.data) && variable.data.length > 0) {
      return variable.data[0]?.value;
    }
    if (variable.value !== undefined) return variable.value;
  }

  const pointData = data.queryPoint || data.closestGridPoint || data.closestGridPointWithData;
  if (pointData) {
    if (pointData.temperature !== undefined) return pointData.temperature;
    if (Array.isArray(pointData.values) && pointData.values.length > 0) {
      return pointData.values[0];
    }
  }

  const flatCandidates = [
    data.temperature,
    data.temp,
    data.value,
    data.current?.temperature,
    data.current?.temp,
    data.data && (data.data.temperature || data.data.temp || data.data.value),
    Array.isArray(data) && data[0]?.temperature,
  ];

  return flatCandidates.find(val => val !== undefined && val !== null) ?? null;
}

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

/**
 * Normaliserer worker-responsen til en flat, kronologisk sortert serie.
 *
 * Nyere workere returnerer `series` med eksplisitt årstall. Eldre workere
 * returnerer kun `weeks` uten år – da antas inneværende ISO-år, som er det
 * beste tilgjengelige gjettet inntil workeren er deployet på nytt.
 */
function normalizeSeries(workerData) {
  if (Array.isArray(workerData.series) && workerData.series.length > 0) {
    return workerData.series
      .filter(entry => entry && entry.value && entry.value.number !== null)
      .map(entry => ({
        year: entry.year,
        week: entry.week,
        value: entry.value.number,
        isEstimate: entry.value.isEstimate,
        raw: entry.raw,
      }))
      .sort((a, b) => weekOrdinal(a.year, a.week) - weekOrdinal(b.year, b.week));
  }

  log('Worker-respons mangler `series` – faller tilbake til `weeks` uten årstall');
  const fallbackYear = getWeekNumber(new Date()).year;

  return Object.keys(workerData.weeks || {})
    .map(week => parseInt(week, 10))
    .filter(week => {
      const entry = workerData.weeks[week];
      return entry && entry.value && entry.value.number !== null;
    })
    .sort((a, b) => a - b)
    .map(week => ({
      year: fallbackYear,
      week,
      value: workerData.weeks[week].value.number,
      isEstimate: workerData.weeks[week].value.isEstimate,
      raw: workerData.weeks[week].raw,
    }));
}

function processWorkerData(workerData) {
  const { week: currentWeek, year: currentYear } = getWeekNumber(new Date());
  const target = weekOrdinal(currentYear, currentWeek);

  log(`Prosesserer worker-data for uke ${currentWeek}, ${currentYear}`);

  const series = normalizeSeries(workerData);
  const availableWeeks = series.map(entry => ({ year: entry.year, week: entry.week }));

  log('Tilgjengelige målinger:', availableWeeks);

  if (series.length === 0) {
    return {
      value: null,
      error: 'Fant ingen måleverdier i datasettet.',
      availableWeeks,
      searchedWeek: currentWeek,
      searchedYear: currentYear,
    };
  }

  // Serien er sortert kronologisk, så vi kan lete bakover for siste måling
  // før inneværende uke. Dette krysser årsskiftet uten spesialtilfeller.
  let index = series.findIndex(entry => weekOrdinal(entry.year, entry.week) === target);
  let matchType = 'exact';

  if (index === -1) {
    for (let i = series.length - 1; i >= 0; i--) {
      if (weekOrdinal(series[i].year, series[i].week) < target) {
        index = i;
        matchType = 'past';
        break;
      }
    }
  }

  if (index === -1) {
    // Ingen tidligere målinger – bruk den nærmeste fremtidige.
    index = 0;
    matchType = 'future';
  }

  const match = series[index];

  if (matchType !== 'exact') {
    console.warn(
      `Fant ikke data for uke ${currentWeek}, ${currentYear}. ` +
        `Bruker uke ${match.week}, ${match.year} i stedet.`
    );
  }

  // Historikk: de siste 5 målingene til og med den valgte
  const history = series.slice(Math.max(0, index - 4), index + 1).map(entry => ({
    week: entry.week,
    year: entry.year,
    value: entry.value,
  }));

  log(
    `Bruker uke ${match.week}, ${match.year} (søkte etter uke ${currentWeek}, ${currentYear}) ` +
      `- verdi: ${match.value} - matchType: ${matchType}`
  );

  return {
    value: match.value,
    availableWeeks,
    searchedWeek: currentWeek,
    searchedYear: currentYear,
    actualWeek: match.week,
    actualYear: match.year,
    isEstimate: match.isEstimate,
    rawValue: match.raw,
    history,
  };
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

  const maxVal = Math.max(...historyData.map(h => h.value), CONFIG.THRESHOLD_HIGH);

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
    <div class="legend-item"><div class="legend-color safe"></div><span>God (&lt;${CONFIG.THRESHOLD_GOOD})</span></div>
    <div class="legend-item"><div class="legend-color caution"></div><span>Mindre god</span></div>
    <div class="legend-item"><div class="legend-color warning"></div><span>Ikke akseptabel (&ge;${CONFIG.THRESHOLD_HIGH})</span></div>
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

// Eksporter funksjoner for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getWeekNumber,
    parseHavvarselJson,
    processWorkerData,
    CONFIG,
  };
}
