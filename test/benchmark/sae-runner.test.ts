import { describe, expect, it } from 'vitest';

import { parseBoolean } from '../../src/benchmark/sae/runner.js';

describe('SAE runner helpers', () => {
  it('parses common truthy values', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('1', false)).toBe(true);
    expect(parseBoolean('YES', false)).toBe(true);
    expect(parseBoolean('on', false)).toBe(true);
  });

  it('parses common falsy values', () => {
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('No', true)).toBe(false);
    expect(parseBoolean('off', true)).toBe(false);
  });

  it('falls back when the value is absent or unrecognized', () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean('maybe', false)).toBe(false);
  });
});
