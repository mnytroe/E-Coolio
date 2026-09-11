import { parseValue } from './utils.js';

// Konfigurasjonsvariabler
const CONFIG = {
  DOC_ID: '1RjJTWQTPRwHtWC-fi1QnelKcpBXXB3eLw7Ld-beK2TE',
  // Tillatte domener for CORS (produksjon)
  ALLOWED_ORIGINS: [
    'https://havet.app',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081',
  ],
  // Rate limiting: maks forespørsler per minutt per IP
  RATE_LIMIT_PER_MINUTE: 60,
  CACHE_TTL_SECONDS: 3600, // 1 time
};

// In-memory rate limiting (resettes ved worker restart)
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minutt
  const record = rateLimitMap.get(ip);

  if (!record || now - record.windowStart > windowMs) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  record.count++;
  if (record.count > CONFIG.RATE_LIMIT_PER_MINUTE) {
    return true;
  }
  return false;
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';

  // Sjekk om origin er tillatt
  if (CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  }

  // Requests uten Origin (curl, server-til-server, /docs-brukere) slipper
  // gjennom. Bevisst valg: dette er ment å være et åpent API, og
  // allowlisten over er derfor en bekvemmelighet for nettlesere, ikke
  // en sikkerhetsgrense. Dataene er offentlige uansett.
  if (!origin) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }

  // Ukjent origin - returner begrenset respons
  return {
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Methods': 'GET',
  };
}

export default {
  async fetch(request, _env, _ctx) {
    const url = new URL(request.url);
    const debug = url.searchParams.get('debug') === 'true';

    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(clientIP)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          ...getCorsHeaders(request),
        },
      });
    }

    // 1. SJEKK HER: Hvis brukeren går til /docs, vis dokumentasjonen
    if (url.pathname === '/docs') {
      return new Response(getDocumentationHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 2. NY SJEKK: Hvis brukeren går til /ukens, vis den enkle HTML-siden
    if (url.pathname === '/ukens') {
      return new Response(getUkensHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // CORS Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getCorsHeaders(request),
      });
    }

    try {
      // Hent HTML fra Google Docs
      const htmlUrl = `https://docs.google.com/document/d/${CONFIG.DOC_ID}/export?format=html`;
      const response = await fetch(htmlUrl, {
        headers: {
          'User-Agent': 'BadevannAPI/1.0',
          Accept: 'text/html',
        },
      });

      if (!response.ok) {
        throw new Error(`Google Docs feilet: ${response.status}`);
      }

      const html = await response.text();
      const originalLength = html.length;

      // Del dokumentet i årssegmenter og behold inneværende + forrige år.
      // Forrige år trengs for at uke 1-3 i januar skal kunne falle tilbake
      // til uke 51/52 i fjor.
      const currentYear = new Date().getFullYear();
      const segments = splitByYear(html, currentYear).filter(seg => seg.year >= currentYear - 1);

      // Parse tabellene per årssegment
      const result = parseSegments(segments, debug);

      // Regex-parsing av Google Docs-HTML er skjørt. Endrer kommunen
      // tabellstrukturen, ville vi ellers returnert en tom serie stille og
      // rolig - og først oppdaget det når noen sier fra. Feil ut i stedet,
      // så det når feilloggen.
      if (result.series.length === 0) {
        throw new Error('Fant ingen målinger i dokumentet. Sannsynligvis endret tabellstruktur.');
      }

      result.lastUpdated = new Date().toISOString();

      if (debug) {
        result._debug = {
          originalHtmlLength: originalLength,
          segments: segments.map(seg => ({ year: seg.year, length: seg.html.length })),
          htmlSnippet: html.substring(0, 2000),
        };
      }

      return new Response(JSON.stringify(result, null, debug ? 2 : 0), {
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders(request),
          'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL_SECONDS}`,
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders(request),
        },
      });
    }
  },
};

/**
 * Deler dokumentet i segmenter per år basert på overskrifter av typen
 * "Resultater for 2025" / "Resultater 2025".
 *
 * Dokumentet er sortert nyest først, så teksten FØR den første markøren hører
 * til året etter den første markøren. Hvis dokumentet ikke er oppdatert med
 * årets tall ennå, gir det riktig årstall likevel: er første markør 2024,
 * er innledningen 2025 – ikke "inneværende år".
 */
export function splitByYear(html, currentYear) {
  const markerRegex = /Resultater\s+(?:for\s+)?(\d{4})/g;
  const markers = [];
  let match;

  while ((match = markerRegex.exec(html)) !== null) {
    markers.push({ year: parseInt(match[1], 10), index: match.index });
  }

  if (markers.length === 0) {
    return [{ year: currentYear, html }];
  }

  const segments = [{ year: markers[0].year + 1, html: html.slice(0, markers[0].index) }];

  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
    segments.push({ year: markers[i].year, html: html.slice(markers[i].index, end) });
  }

  return segments;
}

/**
 * Parser hvert årssegment og slår resultatene sammen til:
 *  - `series`: alle målinger med eksplisitt år (autoritativ kilde)
 *  - `weeks`:  kun inneværende år, i det gamle formatet (bakoverkompatibelt
 *              for klienter som ikke er oppdatert ennå)
 */
export function parseSegments(segments, debug = false) {
  const series = [];
  const tables = debug ? [] : undefined;

  for (const segment of segments) {
    const parsed = parseHtmlToBacteriaData(segment.html, debug);

    for (const [week, entry] of Object.entries(parsed.weeks)) {
      series.push({
        year: segment.year,
        week: parseInt(week, 10),
        raw: entry.raw,
        value: entry.value,
      });
    }

    if (debug && parsed._tables) {
      tables.push(...parsed._tables.map(t => ({ ...t, year: segment.year })));
    }
  }

  series.sort((a, b) => a.year - b.year || a.week - b.week);

  // Bakoverkompatibelt `weeks`-objekt: nyeste år som finnes i dokumentet.
  const latestYear = series.length > 0 ? series[series.length - 1].year : null;
  const weeks = {};
  for (const entry of series) {
    if (entry.year === latestYear) {
      weeks[entry.week] = { raw: entry.raw, value: entry.value };
    }
  }

  return { series, weeks, _tables: tables };
}

function parseHtmlToBacteriaData(html, debug = false) {
  const result = {
    weeks: {},
    _tables: debug ? [] : undefined,
  };

  html = html.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');

  const tableRegex = /<table[^>]*>(.*?)<\/table>/gi;
  let tableMatch;
  let tableIndex = 0;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    tableIndex++;

    const rows = [];
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      const cellRegex = /<t[dh][^>]*>(.*?)<\/t[dh]>/gi;
      let cellMatch;

      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        const cellText = cellMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#(\d+);/g, (_match, num) => String.fromCharCode(num))
          .trim();
        cells.push(cellText);
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (debug && rows.length > 0) {
      result._tables.push({
        index: tableIndex,
        rowCount: rows.length,
        firstRow: rows[0]?.slice(0, 5),
        secondRow: rows[1]?.slice(0, 5),
      });
    }

    let headerRowIndex = -1;
    let havetArenaRowIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      const firstCell = (rows[i][0] || '').toLowerCase();
      if (
        firstCell.includes('pr') &&
        (firstCell.includes('vepunkt') || firstCell.includes('øvepunkt'))
      ) {
        headerRowIndex = i;
      }
      if (firstCell.includes('havet') && firstCell.includes('arena')) {
        havetArenaRowIndex = i;
      }
    }

    if (headerRowIndex !== -1 && havetArenaRowIndex !== -1) {
      const headerRow = rows[headerRowIndex];
      const havetArenaRow = rows[havetArenaRowIndex];

      for (let i = 1; i < headerRow.length; i++) {
        const headerCell = headerRow[i].toLowerCase();
        const weekMatch = headerCell.match(/uke\s*(\d+)/i) || headerCell.match(/^(\d+)$/);

        if (weekMatch) {
          const weekNum = parseInt(weekMatch[1], 10);
          const value = havetArenaRow[i] || '';

          if (value && value !== '-' && value.trim() !== '') {
            result.weeks[weekNum] = {
              raw: value,
              value: parseValue(value),
            };
          }
        }
      }
    }
  }

  return result;
}

// HTML for /ukens
function getUkensHtml() {
  return `<!DOCTYPE html>
  <html lang="no">
  <head>
      <meta charset="UTF-8">
      <title>Badevannskvalitet</title>
  </head>
  <body>
      <div id="content">X</div>
      <script>
          fetch('https://bakterier.nytroe.workers.dev/')
              .then(res => res.json())
              .then(data => {
                  // series er kronologisk sortert med eksplisitt årstall, så
                  // siste element er nyeste måling også over et årsskifte
                  const siste = data.series?.[data.series.length - 1];
                  document.getElementById('content').textContent = siste?.raw ?? 'X';
              })
              .catch(() => document.getElementById('content').textContent = 'X');
      </script>
  </body>
  </html>`;
}

// HTML-dokumentasjon som vises på /docs
function getDocumentationHtml() {
  return `
    <!DOCTYPE html>
    <html lang="no">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>API Dokumentasjon - Badevann Nyhavna</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { border-bottom: 2px solid #0070f3; padding-bottom: 10px; }
        h2 { margin-top: 30px; color: #0070f3; }
        code { background: #f4f4f4; padding: 2px 5px; border-radius: 4px; font-family: monospace; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 8px; overflow-x: auto; border: 1px solid #ddd; }
        .endpoint { background: #e7f5ff; padding: 15px; border-left: 5px solid #0070f3; border-radius: 4px; margin: 20px 0; }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; }
        .get { background: #0070f3; color: white; }
      </style>
    </head>
    <body>
      <h1>🌊 API for Badevannskvalitet (Nyhavna)</h1>
      <p>Dette API-et leverer sanntidsdata for badevannskvalitet (E. coli) målt ved Havet Arena / Nyhavna. Dataene hentes fra Trondheim Kommune og oppdateres automatisk.</p>
      
      <div class="endpoint">
        <span class="tag get">GET</span> <code>https://bakterier.nytroe.workers.dev/</code>
      </div>
  
      <h2>Hvordan bruke det?</h2>
      <p>Du kan hente dataene direkte fra nettleseren (klient-side) da API-et støtter CORS.</p>
  
      <h3>Responsformat (JSON)</h3>
      <pre>{
    "weeks": {
      "20": {
        "raw": "120",
        "value": { "number": 120, "isEstimate": false }
      },
      "21": {
        "raw": "<10",
        "value": { "number": 10, "isEstimate": true }
      }
    },
    "lastUpdated": "2025-06-12T12:00:00Z"
  }</pre>
  
      <h3>Grenseverdier (E. coli cfu/100ml)</h3>
      <ul>
        <li><strong>God:</strong> < 1000</li>
        <li><strong>Mindre god:</strong> 1000 – 4000 (Bading frarådes ofte over 1000)</li>
        <li><strong>Ikke akseptabel:</strong> > 4000</li>
      </ul>
  
      <h3>Eksempelkode (JavaScript)</h3>
      <pre>
  fetch('https://bakterier.nytroe.workers.dev/')
    .then(res => res.json())
    .then(data => {
      // Finn siste uke
      const uker = Object.keys(data.weeks).map(Number).sort((a, b) => b - a);
      const sisteUke = uker[0];
      const maaling = data.weeks[sisteUke];
  
      if (maaling) {
        console.log(\`Uke \${sisteUke}: \${maaling.raw} E. coli\`);
        if (maaling.value.number >= 1000) {
          console.warn("Bading frarådes!");
        }
      }
    });</pre>
    </body>
    </html>
    `;
}
