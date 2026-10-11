import { describe, it, expect } from 'vitest';
import { clearFailures, configuredKey, keysMatch, makeToken, recordFailure, tooManyFailures, verifyToken } from '../lib/access';

const KEY = 'correct-horse-battery-staple-123';
const NOW = Date.UTC(2026, 9, 12);

describe('access key', () => {
  it('is only active when set and long enough', () => {
    expect(configuredKey({ ACCESS_KEY: undefined } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredKey({ ACCESS_KEY: 'short' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredKey({ ACCESS_KEY: `  ${KEY}  ` } as unknown as NodeJS.ProcessEnv)).toBe(KEY);
  });
  it('compares keys exactly', () => {
    expect(keysMatch(KEY, KEY)).toBe(true);
    expect(keysMatch(KEY + 'x', KEY)).toBe(false);
    expect(keysMatch('', KEY)).toBe(false);
  });
});

describe('session token', () => {
  it('accepts a fresh token', () => expect(verifyToken(makeToken(KEY, NOW), KEY, NOW + 1000)).toBe(true));
  it('expires after 90 days', () => {
    const t = makeToken(KEY, NOW);
    expect(verifyToken(t, KEY, NOW + 89 * 86400_000)).toBe(true);
    expect(verifyToken(t, KEY, NOW + 91 * 86400_000)).toBe(false);
  });
  it('rejects a tampered expiry or signature', () => {
    const [exp, sig] = makeToken(KEY, NOW).split('.');
    expect(verifyToken(`${Number(exp) + 999999}.${sig}`, KEY, NOW)).toBe(false);
    expect(verifyToken(`${exp}.${sig.slice(0, -1)}0`, KEY, NOW)).toBe(false);
    expect(verifyToken(`${exp}.`, KEY, NOW)).toBe(false);
  });
  it('rejects garbage and missing values', () => {
    for (const bad of [undefined, null, '', 'abc', '1.2.3', 'NaN.x']) expect(verifyToken(bad as string, KEY, NOW)).toBe(false);
  });
  it('is invalidated by changing the key', () => {
    expect(verifyToken(makeToken(KEY, NOW), KEY + '2', NOW)).toBe(false);
  });
  it('never validates when no key is configured', () => expect(verifyToken(makeToken(KEY, NOW), null, NOW)).toBe(false));
});

describe('throttle', () => {
  it('blocks after 8 failures and resets', () => {
    const id = 'ip-1';
    for (let i = 0; i < 7; i++) recordFailure(id, NOW);
    expect(tooManyFailures(id, NOW)).toBe(false);
    recordFailure(id, NOW);
    expect(tooManyFailures(id, NOW)).toBe(true);
    expect(tooManyFailures(id, NOW + 11 * 60_000)).toBe(false);
    clearFailures(id);
    expect(tooManyFailures(id, NOW)).toBe(false);
  });
});
