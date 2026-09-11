import { describe, it, expect } from 'vitest';
import { classifyValue, formatWeekLabel, processWorkerData, THRESHOLDS } from '../utils.js';
import { splitByYear, parseSegments } from '../worker.js';

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

describe('worker: splitByYear / parseSegments', () => {
  const table = (weeks, values) =>
    `<table><tr><td>Prøvepunkt</td>${weeks.map(w => `<td>Uke ${w}</td>`).join('')}</tr>` +
    `<tr><td>Havet Arena</td>${values.map(v => `<td>${v}</td>`).join('')}</tr>` +
    `<tr><td>Strandveikaia</td>${values.map(() => '<td>9999</td>').join('')}</tr></table>`;

  const doc =
    `<h1>Resultater prøvetaking</h1>${table([1, 2], ['45', '>1200'])}` +
    `<h2>Resultater for 2025</h2>${table([51, 52], ['120', '640'])}` +
    `<h2>Resultater for 2024</h2>${table([30], ['88'])}`;

  const parseDoc = () => parseSegments(splitByYear(doc, 2026).filter(s => s.year >= 2025));

  it('gir hvert segment riktig årstall', () => {
    expect(splitByYear(doc, 2026).map(s => s.year)).toEqual([2026, 2025, 2024]);
  });

  it('utleder året fra markøren når dokumentet ikke er oppdatert ennå', () => {
    const stale = `${table([40], ['70'])}<h2>Resultater for 2024</h2>${table([30], ['88'])}`;

    expect(splitByYear(stale, 2026).map(s => s.year)).toEqual([2025, 2024]);
  });

  it('antar inneværende år når dokumentet ikke har årsmarkører', () => {
    expect(splitByYear(table([40], ['70']), 2026).map(s => s.year)).toEqual([2026]);
  });

  it('godtar «Resultater 2025» uten «for»', () => {
    const html = `${table([1], ['5'])}<h2>Resultater 2025</h2>`;

    expect(splitByYear(html, 2026).map(s => s.year)).toEqual([2026, 2025]);
  });

  it('slår sammen segmenter til en kronologisk serie', () => {
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
});
