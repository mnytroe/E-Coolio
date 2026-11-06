// @vitest-environment node
//
// Kjører den ekte workeren i workerd via Miniflare, slik at HTMLRewriter-
// parsingen testes i samme runtime som i produksjon. Google Docs erstattes
// av en lokal handler som serverer `doc`.
//
// @cloudflare/vitest-pool-workers ville vært det vanlige valget, men krever
// vitest 4. Miniflare direkte fungerer uavhengig av vitest-versjonen.

import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';

const COMPAT_DATE = fs
  .readFileSync('wrangler.toml', 'utf8')
  .match(/compatibility_date\s*=\s*"([^"]+)"/)[1];

let mf;
let doc = '';
let upstreamCalls = 0;

const esm = path => ({ type: 'esm', contents: fs.readFileSync(path, 'utf8') });

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'bakterier',
          compatibilityDate: COMPAT_DATE,
          manifest: {
            mainModule: 'worker.js',
            modules: { 'worker.js': esm('worker.js'), 'utils.js': esm('utils.js') },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: () => {
              upstreamCalls++;
              return new Response(doc, { headers: { 'Content-Type': 'text/html' } });
            },
          },
        },
      },
    ],
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

/** Parser `html` gjennom workeren. debug=true omgår dokument-cachen. */
async function parse(html) {
  doc = html;
  const res = await mf.dispatchFetch('http://localhost/?debug=true');
  return { status: res.status, body: await res.json() };
}

const series = body => body.series.map(e => `${e.year}w${e.week}=${e.raw}`);

const row = cells => `<tr>${cells.map(c => `<td><p><span>${c}</span></p></td>`).join('')}</tr>`;
const table = (weeks, values, { title } = {}) =>
  '<table>' +
  (title ? row([title]) : '') +
  row(['Pr&oslash;vepunkt', ...weeks.map(w => `Uke ${w}`)]) +
  row(['Havet Arena', ...values]) +
  row(['Strandveikaia', ...values.map(() => '9999')]) +
  '</table>';

describe('worker i workerd: HTMLRewriter-parsing', () => {
  it('leser årets første tabell når årsmarkøren står inne i tabellen', async () => {
    // Slik ser Google Docs-dokumentet faktisk ut. Den gamle regex-parseren
    // kuttet dokumentet midt i denne tabellen og mistet uke 1-10 hvert år.
    const html =
      table([1, 2], ['1700', '100'], { title: 'Resultater for 2026' }) +
      table([11], ['42']) +
      table([1, 52], ['80', '640'], { title: 'Resultater for 2025' });

    const { status, body } = await parse(html);

    expect(status).toBe(200);
    expect(series(body)).toEqual([
      '2025w1=80',
      '2025w52=640',
      '2026w1=1700',
      '2026w2=100',
      '2026w11=42',
    ]);
  });

  it('godtar markører som overskrift over tabellen, med og uten «for»', async () => {
    const html =
      `<h2>Resultater for 2026</h2>${table([3], ['5'])}` +
      `<h2>Resultater 2025</h2>${table([52], ['7'])}`;

    expect(series((await parse(html)).body)).toEqual(['2025w52=7', '2026w3=5']);
  });

  it('finner markøren selv når Google Docs deler den over flere spenn', async () => {
    const html = `<p><span>Resultater for </span><span>2025</span></p>${table([40], ['70'])}`;

    expect(series((await parse(html)).body)).toEqual(['2025w40=70']);
  });

  it('dekoder entiteter i verdier og overskrifter', async () => {
    const { body } = await parse(table([1, 2, 3], ['&gt;1200', '&#60;10', '1&nbsp;300']));
    const [w1, w2, w3] = body.series;

    expect([w1.raw, w1.value]).toEqual(['>1200', { number: 1200, isEstimate: true }]);
    expect([w2.raw, w2.value]).toEqual(['<10', { number: 10, isEstimate: true }]);
    expect(w3.value.number).toBe(1300);
  });

  it('ignorerer forrige års eldre årganger', async () => {
    const year = new Date().getFullYear();
    const html =
      table([1], ['5'], { title: `Resultater for ${year}` }) +
      table([1], ['6'], { title: `Resultater for ${year - 1}` }) +
      table([1], ['7'], { title: `Resultater for ${year - 2}` });

    expect(series((await parse(html)).body)).toEqual([`${year - 1}w1=6`, `${year}w1=5`]);
  });

  it('lar ikke tekst i <style> telle som årsmarkør', async () => {
    const html =
      '<style>/* Resultater for 1999 */ p { color: red }</style>' +
      table([4], ['9'], { title: 'Resultater for 2026' });

    expect((await parse(html)).body._debug.blocks[0]).toEqual({ marker: 2026 });
  });

  it('svarer 500 når dokumentet ikke har målinger, i stedet for en tom serie', async () => {
    const { status, body } = await parse('<p>Ingen tabeller her</p>');

    expect(status).toBe(500);
    expect(body.error).toMatch(/ingen målinger/i);
  });
});

describe('worker i workerd: caching og /docs', () => {
  it('henter ferskt med debug=true, og vanlige kall bruker cachen etterpå', async () => {
    const before = upstreamCalls;
    await parse(table([1], ['5'])); // debug: alltid til Google Docs
    expect(upstreamCalls - before).toBe(1);

    // Dokumentet endres "hos Google", men cachen fra debug-kallet gjelder
    doc = table([1], ['999']);
    const first = await (await mf.dispatchFetch('http://localhost/')).json();
    const second = await (await mf.dispatchFetch('http://localhost/')).json();

    expect(upstreamCalls - before).toBe(1);
    expect([first.series[0].raw, second.series[0].raw]).toEqual(['5', '5']);
  });

  it('er et åpent API: samme CORS-svar uansett origin', async () => {
    for (const origin of ['https://havet.app', 'https://annen.side', 'null']) {
      const res = await mf.dispatchFetch('http://localhost/', { headers: { Origin: origin } });
      await res.arrayBuffer();
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  });

  it('viser grenseverdiene fra utils.js på /docs', async () => {
    const html = await (await mf.dispatchFetch('http://localhost/docs')).text();

    expect(html).toContain('<strong>God:</strong> &lt; 100');
    expect(html).toContain('&ge; 1000');
  });
});
