// Unit tests for the workspace city-name allocator.
// Pure: no I/O, no Electron, no DB. Runs in the default node environment.

import { describe, it, expect } from 'vitest';
import { allocate, CITY_NAMES } from './naming';

describe('allocate — naming', () => {
  it('returns the first city when no names are taken', () => {
    const result = allocate([]);
    expect(result).toBe(CITY_NAMES[0]);
  });

  it('skips taken names and returns the first free city', () => {
    const taken = [CITY_NAMES[0], CITY_NAMES[1]];
    const result = allocate(taken);
    expect(result).toBe(CITY_NAMES[2]);
  });

  it('returns distinct names when called for disjoint existing sets', () => {
    const setA = [CITY_NAMES[0]];
    const setB = [CITY_NAMES[1]];
    const nameA = allocate(setA);
    const nameB = allocate(setB);
    expect(nameA).toBe(CITY_NAMES[1]);
    expect(nameB).toBe(CITY_NAMES[0]);
  });

  it('returns a <city>-2 suffix when every base city name is taken', () => {
    const allBase = [...CITY_NAMES];
    const result = allocate(allBase);
    // Should be "<firstCity>-2" since all base names are taken and -2 is tried first
    expect(result).toBe(`${CITY_NAMES[0]}-2`);
  });

  it('increments suffix when <city>-2 variants are also exhausted', () => {
    // Exhaust all base names AND all <city>-2 variants
    const allBase = [...CITY_NAMES];
    const allSuffix2 = CITY_NAMES.map((c) => `${c}-2`);
    const taken = [...allBase, ...allSuffix2];
    const result = allocate(taken);
    // Should be the first city at -3
    expect(result).toBe(`${CITY_NAMES[0]}-3`);
  });

  it('does not return a name that is already in the taken set', () => {
    // Taking all base names and <city>-2 for all except the last city means
    // the last city's -2 variant should be returned
    const allBase = [...CITY_NAMES];
    const allExceptLastSuffix2 = CITY_NAMES.slice(0, -1).map((c) => `${c}-2`);
    const taken = [...allBase, ...allExceptLastSuffix2];
    const result = allocate(taken);
    expect(taken).not.toContain(result);
    expect(result).toBe(`${CITY_NAMES[CITY_NAMES.length - 1]}-2`);
  });

  it('passing the full set again yields another fresh suffixed name', () => {
    // Build the set: all base + all -2 + all -3 to verify -4 is returned
    const allBase = [...CITY_NAMES];
    const allSuffix2 = CITY_NAMES.map((c) => `${c}-2`);
    const allSuffix3 = CITY_NAMES.map((c) => `${c}-3`);
    const firstResult = allocate([...allBase, ...allSuffix2]);
    // firstResult should be <city[0]>-3; now add it and re-call
    const secondResult = allocate([...allBase, ...allSuffix2, firstResult]);
    expect(secondResult).not.toEqual(firstResult);
    // secondResult should be the second city at -3
    expect(secondResult).toBe(`${CITY_NAMES[1]}-3`);
    expect(allBase).not.toContain(secondResult);
    expect(allSuffix2).not.toContain(secondResult);
    expect(allSuffix3.slice(1)).toContain(secondResult);
  });

  it('CITY_NAMES is a non-empty readonly array of unique single-word strings', () => {
    expect(CITY_NAMES.length).toBeGreaterThan(0);
    const unique = new Set(CITY_NAMES);
    expect(unique.size).toBe(CITY_NAMES.length);
    for (const name of CITY_NAMES) {
      expect(typeof name).toBe('string');
      // No spaces or special characters
      expect(/^[a-z]+$/.test(name)).toBe(true);
    }
  });
});
