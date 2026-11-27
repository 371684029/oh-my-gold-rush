import { describe, it, expect } from 'vitest';
import {
  SourceCircuitBreaker,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
} from '../src/utils/source-circuit-breaker.js';

describe('SourceCircuitBreaker (v2.6 M7)', () => {
  it('starts closed and opens after consecutive failures reach threshold', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    const t0 = 1_700_000_000_000;

    expect(breaker.getState('yahoo', t0)).toBe('closed');
    expect(breaker.canRequest('yahoo', t0)).toBe(true);

    breaker.recordFailure('yahoo', 'timeout_1', t0);
    expect(breaker.getState('yahoo', t0 + 1000)).toBe('closed');
    expect(breaker.canRequest('yahoo', t0 + 1000)).toBe(true);

    breaker.recordFailure('yahoo', 'timeout_2', t0 + 2000);
    expect(breaker.getState('yahoo', t0 + 2500)).toBe('open');
    expect(breaker.canRequest('yahoo', t0 + 2500)).toBe(false);
  });

  it('transitions from open -> half_open after cooldown, then closes on success or re-opens on failure', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 });
    const t0 = 1_700_000_000_000;

    breaker.recordFailure('fred', 'ECONNRESET', t0);
    breaker.recordFailure('fred', 'ECONNRESET', t0 + 1000);
    expect(breaker.getState('fred', t0 + 15_000)).toBe('open');

    // Cooldown elapsed -> half_open allows a single probe
    const tProbe = t0 + 1000 + 30_000;
    expect(breaker.getState('fred', tProbe)).toBe('half_open');
    expect(breaker.canRequest('fred', tProbe)).toBe(true);

    // Probe failure immediately re-opens cooldown
    breaker.recordFailure('fred', 'still_down', tProbe);
    expect(breaker.getState('fred', tProbe + 5000)).toBe('open');
    expect(breaker.canRequest('fred', tProbe + 5000)).toBe(false);

    // After second cooldown, probe succeeds -> returns to closed
    const tRecover = tProbe + 31_000;
    expect(breaker.getState('fred', tRecover)).toBe('half_open');
    breaker.recordSuccess('fred', tRecover);
    expect(breaker.getState('fred', tRecover + 1000)).toBe('closed');
    expect(breaker.canRequest('fred', tRecover + 1000)).toBe(true);
  });

  it('short-circuits async execute() during open cooldown without invoking fn', async () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    let now = 1_700_000_000_000;
    let calls = 0;

    const failFn = async (): Promise<number | null> => {
      calls++;
      throw new Error('upstream 504');
    };

    const r1 = await breaker.execute('spdr', failFn, undefined, () => now);
    expect(r1).toEqual({ value: null, skipped: false });
    now += 1000;

    const r2 = await breaker.execute('spdr', failFn, undefined, () => now);
    expect(r2).toEqual({ value: null, skipped: false });
    expect(calls).toBe(2);

    // Now open -> fn must NOT be called
    now += 5000;
    const r3 = await breaker.execute('spdr', failFn, undefined, () => now);
    expect(r3).toEqual({ value: null, skipped: true });
    expect(calls).toBe(2);

    // Health snapshot exposes accurate state and cooldown remaining
    const snap = breaker.getHealthSnapshot(now);
    expect(snap).toHaveLength(1);
    expect(snap[0].source).toBe('spdr');
    expect(snap[0].state).toBe('open');
    expect(snap[0].totalFailures).toBe(2);
    expect(snap[0].cooldownRemainingSec).toBe(55);
  });

  it('normalizes source names case-insensitively and supports reset()', () => {
    const breaker = new SourceCircuitBreaker();
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(2);
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60_000);

    breaker.recordFailure('Yahoo', 'err', 1000);
    breaker.recordFailure('YAHOO', 'err', 2000);
    expect(breaker.getState('yahoo', 3000)).toBe('open');

    breaker.reset('yahoo');
    expect(breaker.getState('yahoo', 3000)).toBe('closed');
    expect(breaker.getHealthSnapshot(3000)).toHaveLength(0);
  });
});
