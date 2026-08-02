/**
 * The outcome -> state mapping, in isolation.
 *
 * This is the one piece of the package whose whole job is a decision, so it is
 * the one piece worth testing exhaustively and with generated input. Everything
 * else in the suite is about whether the real machine agrees.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ENOENT, ENOTSUP, mapProbe, parseExact } from '../src/state.js';

const anyKey = fc.string({ minLength: 1, maxLength: 40 });

describe('mapProbe', () => {
  it('outcome 1 is detected, and the evidence is the key and the value', () => {
    fc.assert(
      fc.property(anyKey, fc.integer({ min: 1, max: 4294967295 }), (key, value) => {
        const cap = mapProbe({
          key,
          outcome: 1,
          value: String(value),
          widthBytes: 4,
          errno: 0,
          strerror: '',
        });
        if (cap.state !== 'detected') return false;
        return (
          cap.evidence.kind === 'sysctl' &&
          cap.evidence.key === key &&
          cap.evidence.value === value &&
          cap.evidence.valueText === String(value)
        );
      }),
      { numRuns: 200 },
    );
  });

  it('outcome 0 is not-present, with the zero it was told, never undetectable', () => {
    fc.assert(
      fc.property(anyKey, (key) => {
        const cap = mapProbe({
          key,
          outcome: 0,
          value: '0',
          widthBytes: 4,
          errno: 0,
          strerror: '',
        });
        return (
          cap.state === 'not-present' &&
          cap.evidence.kind === 'sysctl' &&
          cap.evidence.value === 0
        );
      }),
      { numRuns: 100 },
    );
  });

  it('a read that produced a value never yields undetectable, whatever errno says', () => {
    // errno is only meaningful on the failing branch. A stale or nonsense errno
    // alongside a successful read must not be able to erase a real answer.
    fc.assert(
      fc.property(
        anyKey,
        fc.constantFrom<-1 | 0 | 1>(0, 1),
        fc.integer({ min: 0, max: 200 }),
        (key, outcome, errno) => {
          const cap = mapProbe({
            key,
            outcome,
            value: outcome === 1 ? '1' : '0',
            widthBytes: 4,
            errno,
            strerror: 'whatever',
          });
          return cap.state !== 'undetectable';
        },
      ),
      { numRuns: 200 },
    );
  });

  it('ENOTSUP and ENOENT on the SAME key produce DIFFERENT states', () => {
    // The distinction this package was written around. ENOTSUP is the kernel
    // answering: it publishes the name and says the node does not apply on this
    // architecture. ENOENT is the kernel never having heard of the name.
    const key = 'hw.optional.avx512f';
    const declined = mapProbe({
      key,
      outcome: -1,
      value: '',
      widthBytes: 0,
      errno: ENOTSUP,
      strerror: 'Operation not supported',
    });
    const unknown = mapProbe({
      key,
      outcome: -1,
      value: '',
      widthBytes: 0,
      errno: ENOENT,
      strerror: 'No such file or directory',
    });

    expect(declined.state).toBe('not-present');
    expect(unknown.state).toBe('undetectable');
    expect(declined.state).not.toBe(unknown.state);

    if (declined.state === 'not-present') {
      expect(declined.evidence.kind).toBe('kernel-declined');
    }
    if (unknown.state === 'undetectable') {
      expect(unknown.reason).toMatch(/not in this kernel's MIB/);
      expect(unknown.reason).toMatch(/NOT EVIDENCE OF ABSENCE/);
      // Not permanent: a future macOS could publish the key.
      expect(unknown.permanent).toBe(false);
    }
  });

  it('every errno other than ENOTSUP is undetectable, and names the errno', () => {
    fc.assert(
      fc.property(
        anyKey,
        fc.integer({ min: 1, max: 200 }).filter((e) => e !== ENOTSUP),
        (key, errno) => {
          const cap = mapProbe({
            key,
            outcome: -1,
            value: '',
            widthBytes: 0,
            errno,
            strerror: 'something',
          });
          if (cap.state !== 'undetectable') return false;
          // ENOENT gets its own sentence; everything else must surface the number
          // so a bug report can say what actually happened.
          return errno === ENOENT || cap.reason.includes(String(errno));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a failed read is NEVER not-present unless the kernel declined', () => {
    fc.assert(
      fc.property(anyKey, fc.integer({ min: 0, max: 200 }), (key, errno) => {
        const cap = mapProbe({
          key,
          outcome: -1,
          value: '',
          widthBytes: 0,
          errno,
          strerror: '',
        });
        return cap.state === (errno === ENOTSUP ? 'not-present' : 'undetectable');
      }),
      { numRuns: 200 },
    );
  });
});

describe('parseExact', () => {
  it('round-trips every safe integer and refuses everything else', () => {
    fc.assert(
      fc.property(fc.maxSafeInteger(), (n) => {
        return parseExact(String(n)) === n;
      }),
      { numRuns: 200 },
    );
  });

  it('refuses rather than rounds', () => {
    // hw.optional.arm.caps carries this in its leading 64 bits. Rounding it
    // would be a detection library lying about its own output.
    expect(parseExact('1152375837601820671')).toBeNull();
    expect(parseExact('')).toBeNull();
  });
});
