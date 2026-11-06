import { describe, it, expect } from 'vitest';
import { classifyValue, formatWeekLabel, processWorkerData, THRESHOLDS } from '../utils.js';
import { assignYears, buildResult, decodeEntities } from '../worker.js';

/** Kjører fn med systemklokka låst til et gitt tidspunkt. */
function at(iso, fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      return args.length ? new RealDate(...args) : new RealDate(iso);
    }
    static now() {
      return new RealDate(iso).getTime();
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('classifyValue – Helsedirektoratets vannkvalitetsnormer', () => {
  it.each([
    [0, 'green'],
    [99, 'green'],
    [100, 'yellow'],
    [499, 'yellow'],
    [780, 'yellow'],
    [999, 'yellow'],
    [1000, 'red'],
    [5000, 'red'],
  ])('%i CFU/100 ml gir nivå %s', (value, level) => {
    expect(classifyValue(value).level).toBe(level);
  });

  it('nevner oppfølgingsprøve fra og med kommunens 500-grense', () => {
    expect(classifyValue(500).label).toContain('oppfølgingsprøve');
    expect(classifyValue(499).label).not.toContain('oppfølgingsprøve');
  });

  it('holder grenseverdiene i CONFIG konsistente', () => {
    expect(THRESHOLDS.GOOD).toBeLessThan(THRESHOLDS.FOLLOWUP);
    expect(THRESHOLDS.FOLLOWUP).toBeLessThan(THRESHOLDS.HIGH);
  });
});

describe('processWorkerData – uke-oppslag over årsskiftet', () => {
  const series = [
    { year: 2025, week: 50, raw: '78', value: { number: 78, isEstimate: false } },
    { year: 2025, week: 51, raw: '120', value: { number: 120, isEstimate: false } },
    { year: 2025, week: 52, raw: '640', value: { number: 640, isEstimate: false } },
    { year: 2026, week: 3, raw: '55', value: { number: 55, isEstimate: false } },
  ];

  it('faller tilbake til forrige år når året er nytt og data mangler', () => {
    const result = at('2026-01-05T12:00:00Z', () => processWorkerData({ series }));

    expect(result.actualWeek).toBe(52);
    expect(result.actualYear).toBe(2025);
    expect(result.value).toBe(640);
    expect(result.error).toBeUndefined();
  });

  it('bygger historikk på tvers av årsskiftet', () => {
    const result = at('2026-01-05T12:00:00Z', () => processWorkerData({ series }));

    expect(result.history.map(h => `${h.year}w${h.week}`)).toEqual([
      '2025w50',
      '2025w51',
      '2025w52',
    ]);
  });

  it('foretrekker eksakt treff på inneværende uke og år', () => {
    const result = at('2026-01-14T12:00:00Z', () => processWorkerData({ series }));

    expect([result.actualWeek, result.actualYear, result.value]).toEqual([3, 2026, 55]);
  });

  it('godtar gammelt worker-format uten årstall', () => {
    const weeks = { 50: series[0], 51: series[1], 52: series[2] };
    const result = at('2025-12-23T12:00:00Z', () => processWorkerData({ weeks }));

    expect([result.actualWeek, result.actualYear, result.value]).toEqual([52, 2025, 640]);
  });

  it('bruker nærmeste fremtidige måling når ingen tidligere finnes', () => {
    const result = at('2026-01-05T12:00:00Z', () => processWorkerData({ series: [series[3]] }));

    expect([result.actualWeek, result.actualYear]).toEqual([3, 2026]);
  });

  it('returnerer en tydelig feil for tomt datasett i stedet for å krasje', () => {
    const result = at('2026-01-05T12:00:00Z', () => processWorkerData({ series: [] }));

    expect(result.value).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe('formatWeekLabel', () => {
  it('utelater årstall for inneværende år', () => {
    expect(at('2026-01-14T12:00:00Z', () => formatWeekLabel({ week: 3, year: 2026 }))).toBe(
      'Uke 3'
    );
  });

  it('viser årstall når målingen er fra et annet år', () => {
    expect(at('2026-01-05T12:00:00Z', () => formatWeekLabel({ week: 52, year: 2025 }))).toBe(
      'Uke 52 · 2025'
    );
  });
});

// HTML -> blokker testes i workerd: tests/worker-runtime.test.js
describe('worker: assignYears / buildResult', () => {
  const table = (weeks, values) => ({
    type: 'table',
    rows: [
      ['Prøvepunkt', ...weeks.map(w => `Uke ${w}`)],
      ['Havet Arena', ...values],
      ['Strandveikaia', ...values.map(() => '9999')],
    ],
  });
  const marker = year => ({ type: 'marker', year });

  const blocks = [
    table([1, 2], ['45', '>1200']),
    marker(2025),
    table([51, 52], ['120', '640']),
    marker(2024),
    table([30], ['88']),
  ];

  const parseDoc = () => buildResult(assignYears(blocks, 2026).filter(t => t.year >= 2025));

  it('gir hver tabell årstallet til markøren over den', () => {
    expect(assignYears(blocks, 2026).map(t => t.year)).toEqual([2026, 2025, 2024]);
  });

  it('gir tabellen årstallet til en markør rett foran den', () => {
    // Slik extractBlocks gir det når markøren står inne i tabellen
    const inTable = [marker(2026), table([1], ['5']), marker(2025), table([52], ['7'])];

    expect(assignYears(inTable, 2026).map(t => t.year)).toEqual([2026, 2025]);
  });

  it('utleder året fra markøren når dokumentet ikke er oppdatert ennå', () => {
    const stale = [table([40], ['70']), marker(2024), table([30], ['88'])];

    expect(assignYears(stale, 2026).map(t => t.year)).toEqual([2025, 2024]);
  });

  it('antar inneværende år når dokumentet ikke har årsmarkører', () => {
    expect(assignYears([table([40], ['70'])], 2026).map(t => t.year)).toEqual([2026]);
  });

  it('slår sammen tabellene til en kronologisk serie', () => {
    expect(parseDoc().series.map(e => `${e.year}w${e.week}=${e.value.number}`)).toEqual([
      '2025w51=120',
      '2025w52=640',
      '2026w1=45',
      '2026w2=1200',
    ]);
  });

  it('markerer «>»-verdier som estimat', () => {
    expect(parseDoc().series.find(e => e.week === 2).value.isEstimate).toBe(true);
  });

  it('beholder et bakoverkompatibelt weeks-objekt for nyeste år', () => {
    expect(Object.keys(parseDoc().weeks)).toEqual(['1', '2']);
  });

  it('ignorerer Strandveikaia og leser kun Havet Arena', () => {
    expect(parseDoc().series.some(e => e.value.number === 9999)).toBe(false);
  });

  it('hopper over tomme celler og «-»', () => {
    const result = buildResult([{ year: 2026, ...table([1, 2, 3], ['', '-', '12']) }]);

    expect(result.series.map(e => e.week)).toEqual([3]);
  });
});

describe('worker: decodeEntities', () => {
  it.each([
    ['Pr&oslash;vepunkt', 'Prøvepunkt'],
    ['&AElig;&Oslash;&Aring; &aelig;&aring;', 'ÆØÅ æå'],
    ['&gt;1200', '>1200'],
    ['&#62;1200', '>1200'],
    ['&#x3e;1200', '>1200'],
    ['a&nbsp;b', 'a b'],
    ['&amp;lt;', '&lt;'],
  ])('%s -> %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it('lar ukjente og ugyldige entiteter stå urørt', () => {
    expect(decodeEntities('&ukjent; &#0; &#x110000;')).toBe('&ukjent; &#0; &#x110000;');
  });
});
