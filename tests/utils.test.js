import { describe, it, expect } from 'vitest';
import { getWeekNumber, parseHavvarselJson, parseValue, weekOrdinal } from '../utils.js';

describe('getWeekNumber', () => {
  it('should return correct week for January 1st', () => {
    const result = getWeekNumber(new Date(2025, 0, 1)); // Jan 1, 2025
    expect(result.week).toBe(1);
    expect(result.year).toBe(2025);
  });

  it('should return correct week for mid-year date', () => {
    const result = getWeekNumber(new Date(2025, 5, 15)); // June 15, 2025
    expect(result.week).toBe(24);
    expect(result.year).toBe(2025);
  });

  it('should handle year boundary correctly', () => {
    const result = getWeekNumber(new Date(2024, 11, 31)); // Dec 31, 2024
    // Week 1 of 2025 starts on Dec 30, 2024
    expect(result.week).toBe(1);
    expect(result.year).toBe(2025);
  });

  it('should return week 52 for late December', () => {
    const result = getWeekNumber(new Date(2025, 11, 28)); // Dec 28, 2025
    expect(result.week).toBe(52);
    expect(result.year).toBe(2025);
  });
});

describe('weekOrdinal', () => {
  it('sorterer uke 1 i nytt år etter uke 52 i fjor', () => {
    expect(weekOrdinal(2025, 52)).toBeLessThan(weekOrdinal(2026, 1));
  });

  it('bevarer rekkefølgen innenfor samme år', () => {
    expect(weekOrdinal(2025, 9)).toBeLessThan(weekOrdinal(2025, 10));
  });
});

describe('parseHavvarselJson', () => {
  it('should return null for null input', () => {
    expect(parseHavvarselJson(null)).toBe(null);
  });

  it('should parse variables array format', () => {
    const data = {
      variables: [{ data: [{ value: 8.5 }] }],
    };
    expect(parseHavvarselJson(data)).toBe(8.5);
  });

  it('should parse variables entry without data array', () => {
    const data = {
      variables: [{ value: 7.2 }],
    };
    expect(parseHavvarselJson(data)).toBe(7.2);
  });

  it('should parse queryPoint format', () => {
    const data = {
      queryPoint: { temperature: 10.2 },
    };
    expect(parseHavvarselJson(data)).toBe(10.2);
  });

  it('should parse flat temperature format', () => {
    const data = { temperature: 7.8 };
    expect(parseHavvarselJson(data)).toBe(7.8);
  });

  it('should parse current.temperature format', () => {
    const data = {
      current: { temperature: 9.1 },
    };
    expect(parseHavvarselJson(data)).toBe(9.1);
  });

  it('should return null/falsy for empty object', () => {
    // Funksjonen kan returnere null eller false for ugyldige data
    expect(parseHavvarselJson({})).toBeFalsy();
  });
});

describe('parseValue', () => {
  it('should parse simple number', () => {
    const result = parseValue('120');
    expect(result.number).toBe(120);
    expect(result.isEstimate).toBe(false);
  });

  it('should parse number with greater-than sign as estimate', () => {
    const result = parseValue('>1000');
    expect(result.number).toBe(1000);
    expect(result.isEstimate).toBe(true);
  });

  it('should parse number with less-than sign as estimate', () => {
    const result = parseValue('<10');
    expect(result.number).toBe(10);
    expect(result.isEstimate).toBe(true);
  });

  it('should handle decimal with comma', () => {
    const result = parseValue('12,5');
    expect(result.number).toBe(12.5);
    expect(result.isEstimate).toBe(false);
  });

  it('should return null for empty string', () => {
    const result = parseValue('');
    expect(result).toBe(null);
  });

  it('should return null number for non-numeric string', () => {
    const result = parseValue('abc');
    expect(result.number).toBe(null);
    expect(result.isEstimate).toBe(false);
  });
});
