// === KONFIGURASJON ===
const CONFIG = {
    DEBUG: false,
    CACHE_KEY: 'havet_arena_data',
    CACHE_DURATION: 1000 * 60 * 60, // 1 time
    CACHE_VERSION: 6, // v6: Separate filer, kun Cloudflare Workers
    THRESHOLD_HIGH: 1000, // CFU/100ml
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    THEME_KEY: 'havet_arena_theme'
};

let CURRENT_REQUEST_ID = 0;

// Koordinater for Havet Arena, Nyhavna
const LAT = 63.44181;
const LON = 10.42506;

// === HJELPEFUNKSJONER ===

function log(...args) {
    if (CONFIG.DEBUG) {
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

async function fetchWithRetry(fetchFn, maxRetries = CONFIG.RETRY_ATTEMPTS, delay = CONFIG.RETRY_DELAY) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fetchFn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            log(`Forsøk ${i + 1} feilet, prøver igjen om ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { week: weekNum, year: d.getUTCFullYear() };
}

// === VÆRTEMPERATUR (Open-Meteo) ===

async function getTempAtHavetSauna() {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m&timezone=Europe%2FOslo`;
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
        
        if (tempElement && tempValue && temp !== null && temp !== undefined) {
            tempValue.textContent = Math.round(temp);
            tempElement.style.display = 'flex';
        }
    } catch (error) {
        log('Kunne ikke hente temperatur:', error);
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
        data.temperature, data.temp, data.value,
        data.current?.temperature, data.current?.temp,
        (data.data && (data.data.temperature || data.data.temp || data.data.value)),
        (Array.isArray(data) && data[0]?.temperature)
    ];

    return flatCandidates.find(val => val !== undefined && val !== null) ?? null;
}

async function fetchFromWorker() {
    const url = `https://bading.nytroe.workers.dev/?lat=${LAT}&lon=${LON}`;
    const res = await fetchWithRetry(() => fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }));
    if (!res.ok) throw new Error(`Worker status: ${res.status}`);
    
    const data = await res.json();
    const temp = data?.now?.sea_water_temperature;
    
    if (temp === undefined || temp === null) throw new Error('Ingen temperatur i worker-data');
    return temp;
}

async function fetchFromHavvarselDirect() {
    const url = `https://api.havvarsel.no/apis/duapi/havvarsel/v2/temperatureprojection/${LON}/${LAT}`;
    const res = await fetchWithRetry(() => fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }));
    if (!res.ok) throw new Error(`API status: ${res.status}`);
    
    const data = await res.json();
    const temp = parseHavvarselJson(data);
    
    if (temp === undefined || temp === null) throw new Error('Fant ikke temperatur i API-data');
    return temp;
}

async function fetchFromHavvarselProxy() {
    const targetUrl = `https://api.havvarsel.no/apis/duapi/havvarsel/v2/temperatureprojection/${LON}/${LAT}`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
    
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
        { name: 'Havvarsel Proxy', fn: fetchFromHavvarselProxy }
    ];

    log('Starter henting av badetemperatur...');

    for (const source of sources) {
        try {
            log(`Prøver kilde: ${source.name}...`);
            const temp = await source.fn();
            
            if (typeof temp === 'number' && !isNaN(temp)) {
                log(`✅ Suksess med ${source.name}: ${temp}°C`);
                return temp;
            } else {
                log(`⚠️ ${source.name} returnerte ugyldig data:`, temp);
            }
        } catch (error) {
            log(`❌ ${source.name} feilet:`, error.message);
        }
    }

    log('⛔ Alle kilder feilet. Ingen badetemperatur funnet.');
    return null;
}

async function updateSeaTemperature() {
    try {
        const temp = await getSeaTemperatureAtHavetArena();
        const seaTempElement = document.getElementById('seaTemperature');
        const seaTempValue = document.getElementById('seaTempValue');
        
        if (seaTempElement && seaTempValue && temp !== null && temp !== undefined) {
            seaTempValue.textContent = Math.round(temp);
            seaTempElement.style.display = 'flex';
            log('Badetemperatur oppdatert i UI:', Math.round(temp));
        }
    } catch (error) {
        log('Kunne ikke hente badetemperatur:', error);
    }
}

// === BAKTERIEDATA (Cloudflare Worker) ===

async function fetchFromBakterierWorker() {
    const workerUrl = 'https://bakterier.nytroe.workers.dev/';
    log('Henter bakteriedata fra Cloudflare Worker:', workerUrl);
    
    const response = await fetchWithRetry(() => fetchWithTimeout(workerUrl, {
        method: 'GET',
        mode: 'cors',
        headers: { 'Accept': 'application/json' }
    }));
    
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

function processWorkerData(workerData) {
    const currentDate = new Date();
    const { week: currentWeek } = getWeekNumber(currentDate);
    
    log('Prosesserer worker-data for uke:', currentWeek);
    
    const availableWeeks = Object.keys(workerData.weeks)
        .map(w => parseInt(w, 10))
        .filter(w => {
            const weekData = workerData.weeks[w];
            return weekData && weekData.value && weekData.value.number !== null;
        })
        .sort((a, b) => a - b);
    
    log('Tilgjengelige uker med verdier:', availableWeeks);
    
    let actualWeek = currentWeek;
    let matchType = 'exact';
    
    if (!availableWeeks.includes(currentWeek)) {
        if (availableWeeks.includes(currentWeek - 1)) {
            actualWeek = currentWeek - 1;
            matchType = 'past';
        } else {
            const pastWeeks = availableWeeks.filter(w => w < currentWeek).sort((a, b) => b - a);
            if (pastWeeks.length > 0) {
                actualWeek = pastWeeks[0];
                matchType = 'past';
            } else {
                const futureWeeks = availableWeeks.filter(w => w > currentWeek).sort((a, b) => a - b);
                if (futureWeeks.length > 0) {
                    actualWeek = futureWeeks[0];
                    matchType = 'future';
                }
            }
        }
        
        if (matchType !== 'exact') {
            console.warn(`⚠️ ADVARSEL: Fant ikke data for uke ${currentWeek}. Bruker uke ${actualWeek} i stedet.`);
        }
    }
    
    const weekData = workerData.weeks[actualWeek];
    if (!weekData || weekData.value.number === null) {
        return {
            value: null,
            error: `Ingen verdi funnet for uke ${actualWeek}`,
            availableWeeks,
            searchedWeek: currentWeek
        };
    }
    
    const foundValue = weekData.value.number;
    const isEstimate = weekData.value.isEstimate;
    const rawValue = weekData.raw;
    
    // Bygg historikk for siste 5 uker med verdier (inkluderer ukenummer)
    const history = availableWeeks
        .filter(w => w <= actualWeek)
        .slice(-5)
        .map(w => ({
            week: w,
            value: workerData.weeks[w].value.number
        }))
        .filter(h => h.value !== null);
    
    log(`✅ Bruker uke ${actualWeek} (søkte etter ${currentWeek}) - verdi: ${foundValue} - matchType: ${matchType}`);
    
    return {
        value: foundValue,
        availableWeeks,
        searchedWeek: currentWeek,
        actualWeek,
        isEstimate,
        rawValue,
        history
    };
}

async function fetchSheetData() {
    try {
        log('Henter data fra Cloudflare Worker...');
        const workerData = await fetchFromBakterierWorker();
        return processWorkerData(workerData);
    } catch (error) {
        console.error('Feil ved henting av bakteriedata:', error);
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

    const isDarkMode = typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;

    const values = historyData.map(h => h.value);
    const weeks = historyData.map(h => h.week);
    
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
        return { x, y, val, week: weeks[idx] };
    });

    // Tegn linjen
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();

    // Tegn punkter
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#667eea';
    points.forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });

    // Tegn verdier over hvert punkt
    ctx.fillStyle = '#7f8c8d';
    ctx.font = '10px Segoe UI';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    points.forEach(pt => {
        ctx.fillText(`${Math.round(pt.val)}`, pt.x, pt.y - 8);
    });

    // Tegn ukenummer under hvert punkt
    ctx.fillStyle = isDarkMode ? '#cbd5e1' : '#7f8c8d';
    ctx.font = '11px Segoe UI';
    ctx.textBaseline = 'top';
    points.forEach(pt => {
        ctx.fillText(`uke ${pt.week}`, pt.x, canvas.height - 18);
    });

    return canvas;
}

// Bar chart for brutalist tema
function createBarChart(historyData = []) {
    if (!historyData || historyData.length === 0) return null;
    
    const values = historyData.map(h => h.value);
    const weeks = historyData.map(h => h.week);
    const maxVal = Math.max(...values);
    
    const container = document.createElement('div');
    container.className = 'graph-bars';
    
    historyData.forEach((item) => {
        const heightPercent = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
        const barContainer = document.createElement('div');
        barContainer.className = 'bar-container';
        barContainer.innerHTML = `
            <div class="bar-value">${Math.round(item.value)}</div>
            <div class="bar" style="height: ${heightPercent}%;"></div>
            <div class="bar-label">Uke ${item.week}</div>
        `;
        container.appendChild(barContainer);
    });
    
    return container;
}

// === TEMA-FUNKSJONALITET ===

function getTheme() {
    return localStorage.getItem(CONFIG.THEME_KEY) || 'modern';
}

function setTheme(theme) {
    localStorage.setItem(CONFIG.THEME_KEY, theme);
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

// Eksponer globalt for HTML onclick
window.toggleTheme = toggleTheme;

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
    let isEstimate = false;
    let rawValue = null;
    let history = null;
    
    if (typeof result === 'object' && result !== null) {
        value = result.value;
        errorMessage = result.error;
        actualWeek = result.actualWeek;
        isEstimate = result.isEstimate;
        rawValue = result.rawValue;
        history = result.history;
    } else {
        value = result;
    }
    
    if (value === null || isNaN(value)) {
        error.style.display = 'block';
        if (errorMessage) {
            error.innerHTML = errorMessage.replace(/\n/g, '<br>');
        } else {
            const { week: currentWeek } = getWeekNumber(new Date());
            error.textContent = 'Kunne ikke finne verdi for gjeldende uke. Sjekk at dataene har verdier for uke ' + currentWeek + '.';
        }
        return;
    }
    
    content.style.display = 'block';
    
    const currentDate = new Date();
    const { week: currentWeek, year: currentWeekYear } = getWeekNumber(currentDate);
    
    valueDisplay.textContent = Math.round(value);
    
    if (value >= CONFIG.THRESHOLD_HIGH) {
        valueDisplay.className = 'value-display red';
        if (statusTextLabel) statusTextLabel.textContent = 'Ikke anbefalt for bading';
        else statusText.textContent = 'Ikke anbefalt for bading';
        if (statusIconPath) {
            statusIconPath.setAttribute('d', 'M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.75c1.155 2-.289 4.5-2.598 4.5H4.644c-2.309 0-3.752-2.5-2.598-4.5L9.401 3.003zM12 8.25a.75.75 0 00-.75.75v3a.75.75 0 001.5 0v-3a.75.75 0 00-.75-.75zm0 6a.75.75 0 100 1.5.75.75 0 000-1.5z');
        }
        const theme = getTheme();
        statusText.className = theme === 'brutalist' ? 'status-text warning' : 'status-text red';
    } else {
        valueDisplay.className = 'value-display green';
        if (statusTextLabel) statusTextLabel.textContent = 'Trygt for bading';
        else statusText.textContent = 'Trygt for bading';
        if (statusIconPath) {
            statusIconPath.setAttribute('d', 'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z');
        }
        statusText.className = 'status-text green';
    }
    
    const weekToShow = actualWeek !== null && actualWeek !== undefined ? actualWeek : currentWeek;
    if (actualWeek !== null && actualWeek !== currentWeek) {
        weekInfo.textContent = `Uke ${weekToShow} (søkte etter uke ${currentWeek}), ${currentWeekYear}`;
    } else {
        weekInfo.textContent = `Uke ${weekToShow}, ${currentWeekYear}`;
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
    } catch (e) {
        log('Klarte ikke lese cache:', e);
    }

    const data = await fetchSheetData();

    try {
        localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({
            data,
            timestamp: Date.now(),
            version: CONFIG.CACHE_VERSION
        }));
    } catch (e) {
        log('Klarte ikke skrive cache:', e);
    }

    return data;
}

// === SERVICE WORKER ===

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => log('Service Worker registrert'))
        .catch(err => log('Service Worker feilet:', err));
}

// === INITIALISERING ===

document.addEventListener('DOMContentLoaded', async () => {
    // Initialiser tema
    initTheme();
    
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
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').innerHTML = error.message.replace(/\n/g, '<br>');
    }
});

