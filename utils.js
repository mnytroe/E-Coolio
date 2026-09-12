/**
 * Ren, DOM-uavhengig logikk delt mellom frontend (app.js), Cloudflare-workeren
 * (worker.js) og testene. Ingenting her skal røre `document`, `window`,
 * `localStorage` eller nettverket – da kan modulen importeres like godt i en
 * nettleser, i Workers-runtime og i vitest.
 */

/**
 * Appversjonen. Eneste sted den skal endres.
 *
 * Herfra utledes tre ting som tidligere måtte bumpes hver for seg:
 *  - Sentry-releasen  (app.js)
 *  - localStorage-cachen (app.js)
 *  - Service Worker-cachen, via ?v= på registreringen (sw.js)
 *
 * Bump ved endringer som gjør gammel cache ugyldig, eller ved ny utgivelse.
 */
export const APP_VERSION = '1.1.1';

// === DEBUG-LOGGING ===

let debugEnabled = false;

/** Slår debug-logging fra denne modulen av eller på. Settes av app.js ved oppstart. */
export function setDebug(value) {
  debugEnabled = Boolean(value);
}

function log(...args) {
  if (debugEnabled) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

// === GRENSEVERDIER ===

/**
 * Grenseverdier for E. coli (CFU/100 ml).
 * Kilde: Helsedirektoratets vannkvalitetsnormer for friluftsbad.
 *   < 100   -> God
 *   100-999 -> Mindre god
 *   >= 1000 -> Ikke akseptabel
 * FOLLOWUP er Trondheim kommunes grense for å ta oppfølgingsprøve, og ligger
 * inne i "mindre god"-intervallet.
 */
export const THRESHOLDS = {
  GOOD: 100,
  FOLLOWUP: 500,
  HIGH: 1000,
};

/** SVG-paths for statusikonene. */
export const ICON_PATHS = {
  success:
    'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z',
  caution:
    'M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12 6a.75.75 0 01.75.75v5.5a.75.75 0 01-1.5 0v-5.5A.75.75 0 0112 6zm0 10.5a.9.9 0 110 1.8.9.9 0 010-1.8z',
  warning:
    'M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.75c1.155 2-.289 4.5-2.598 4.5H4.644c-2.309 0-3.752-2.5-2.598-4.5L9.401 3.003zM12 8.25a.75.75 0 00-.75.75v3a.75.75 0 001.5 0v-3a.75.75 0 00-.75-.75zm0 6a.75.75 0 100 1.5.75.75 0 000-1.5z',
};

/**
 * Klassifiserer en E. coli-verdi etter vannkvalitetsnormene.
 * Returnerer nivå, brukervendt tekst og hvilket ikon som skal vises.
 */
export function classifyValue(value) {
  if (value >= THRESHOLDS.HIGH) {
    return {
      level: 'red',
      label: 'Ikke akseptabel – ikke anbefalt for bading',
      icon: ICON_PATHS.warning,
    };
  }

  if (value >= THRESHOLDS.GOOD) {
    const needsFollowUp = value >= THRESHOLDS.FOLLOWUP;
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

// === UKENUMMER ===

/** ISO-8601 ukenummer og tilhørende år for en gitt dato. */
export function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week: weekNum, year: d.getUTCFullYear() };
}

/** Sammenlignbart løpenummer for (år, uke) slik at uker kan sorteres på tvers av årsskiftet. */
export function weekOrdinal(year, week) {
  return year * 100 + week;
}

/**
 * Kort ukelabel til grafene. Årstall vises kun når målingen er fra et annet år
 * enn inneværende, slik at januar-fallback til fjoråret ikke blir forvirrende.
 */
export function formatWeekLabel({ week, year }) {
  const currentYear = getWeekNumber(new Date()).year;
  return year && year !== currentYear ? `Uke ${week} · ${year}` : `Uke ${week}`;
}

// === PARSING ===

/**
 * Tolker en celleverdi fra prøvetakingsdokumentet.
 * Verdier som "&gt;1200" eller "&lt;10" regnes som estimater.
 */
export function parseValue(str) {
  if (!str) return null;
  const isEstimate = str.includes('>') || str.includes('<');
  const cleaned = str.replace(/[^0-9.,]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);

  return {
    number: isNaN(num) ? null : num,
    isEstimate,
  };
}

/** Plukker sjøtemperatur ut av de ulike formene Havvarsel-APIet svarer med. */
export function parseHavvarselJson(data) {
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

// === UKE-OPPSLAG ===

/**
 * Normaliserer worker-responsen til en flat, kronologisk sortert serie.
 *
 * Nyere workere returnerer `series` med eksplisitt årstall. Eldre workere
 * returnerer kun `weeks` uten år – da antas inneværende ISO-år, som er det
 * beste tilgjengelige gjettet inntil workeren er deployet på nytt.
 */
export function normalizeSeries(workerData) {
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

/**
 * Velger hvilken måling som skal vises for inneværende uke, med fallback
 * bakover i tid. Sorteringen på (år, uke) gjør at årsskiftet håndteres uten
 * spesialtilfeller: uke 1 finner uke 52 i fjor.
 */
export function processWorkerData(workerData) {
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
  // før inneværende uke.
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
