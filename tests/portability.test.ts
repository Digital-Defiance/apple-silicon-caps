/**
 * The portability surface: asking about an id that may not exist here.
 *
 * The problem this file guards. Of the addressable ids on this machine, only the
 * documented handful are declared by this package; the rest are DISCOVERED from
 * this kernel's `hw.optional` MIB. `has('cssc')` answers on this M4 Max because
 * the kernel publishes FEAT_CSSC (reporting 0), and would THROW on a machine
 * whose kernel never publishes that name. A consumer writing
 * `if (caps.has('cssc'))` would then work on one Mac and crash on another.
 *
 * The fix is NOT to make `has()` return false for anything it does not
 * recognise. That would turn every typo into a permanent, undiagnosable false —
 * the same lie in a new place. The fix is to give the caller a way to SAY what
 * an unknown id means for them, and to leave the bare call throwing.
 */
import { describe, expect, it } from 'vitest';

import caps, { CapsError, CapsErrorCode, DOCUMENTED_LEAVES } from '../src/index.js';

/** Ids nothing can answer to. Not typos of real names, just absent. */
const ABSENT_IDS = [
  'future_feat_xyz',
  'FEAT_NOT_INVENTED_YET',
  'hw.optional.arm.FEAT_MADE_UP',
  '',
  '   ',
] as const;

describe('lookup()', () => {
  it('returns undefined instead of throwing for an id nothing answers to', () => {
    for (const id of ABSENT_IDS) {
      expect(caps.lookup(id), id).toBeUndefined();
    }
  });

  it('never throws, for any input at all', () => {
    for (const id of [...ABSENT_IDS, 'sme', 'aes', '...', '\u0000', 'a'.repeat(4096)]) {
      expect(() => caps.lookup(id), id).not.toThrow();
    }
  });

  it('returns the same record detail() returns when the id does resolve', () => {
    for (const id of ['neon', 'sme', 'amx', 'hw.optional.aes']) {
      expect(caps.lookup(id)).toStrictEqual(caps.detail(id));
    }
  });

  it('accepts the same spellings detail() accepts', () => {
    const expected = caps.detail('sme2').id;
    for (const spelling of ['sme2', 'SME2', 'FEAT_SME2', 'hw.optional.arm.FEAT_SME2']) {
      expect(caps.lookup(spelling)?.id, spelling).toBe(expected);
    }
  });

  it('is the honest answer for a discovered id: a record here, undefined elsewhere', () => {
    // cssc is the concrete case. This kernel publishes it, so there is a record
    // and its state is a real answer rather than a guess. On a kernel that does
    // not publish the name, this same call returns undefined and the caller can
    // see that nothing was learned - which is different from "not present".
    const cssc = caps.lookup('cssc');
    if (cssc !== undefined) {
      expect(cssc.sysctlKey).toBe('hw.optional.arm.FEAT_CSSC');
      expect(['detected', 'not-present']).toContain(cssc.state);
    }
  });
});

describe('has(id, { ifUnknown })', () => {
  it('returns the supplied default for an unknown id instead of throwing', () => {
    for (const id of ABSENT_IDS) {
      expect(caps.has(id, { ifUnknown: false }), id).toBe(false);
      expect(caps.has(id, { ifUnknown: true }), id).toBe(true);
    }
  });

  it('does not let ifUnknown override a real answer', () => {
    // The option governs UNKNOWN IDS only. It must never be able to flip a
    // capability that was actually established, or one the kernel answered no
    // to; that would make the option a way to lie.
    expect(caps.has('sme', { ifUnknown: false })).toBe(true);
    expect(caps.has('sme', { ifUnknown: true })).toBe(true);

    // amx is undetectable, and stays false: it is a KNOWN id, so ifUnknown does
    // not apply to it. Callers who want a default for undetectable use
    // isEnabled(detail(id), true), which says so at the call site.
    expect(caps.has('amx', { ifUnknown: true })).toBe(false);
    expect(caps.detail('amx').state).toBe('undetectable');

    // A key the kernel declined for this architecture is a real not-present.
    const avx512 = caps.lookup('avx512f');
    if (avx512 !== undefined) {
      expect(avx512.state).toBe('not-present');
      expect(caps.has('avx512f', { ifUnknown: true })).toBe(false);
    }
  });

  it('agrees with the bare form for every id that resolves', () => {
    for (const cap of caps.all()) {
      expect(caps.has(cap.id, { ifUnknown: true }), cap.id).toBe(caps.has(cap.id));
      expect(caps.has(cap.id, { ifUnknown: false }), cap.id).toBe(caps.has(cap.id));
    }
  });
});

describe('bare has(id) still throws', () => {
  it('throws UNKNOWN_CAPABILITY when no second argument is supplied', () => {
    for (const id of ABSENT_IDS) {
      expect(() => caps.has(id), id).toThrowError(CapsError);
    }
    try {
      caps.has('future_feat_xyz');
      expect.unreachable();
    } catch (err) {
      expect((err as CapsError).code).toBe(CapsErrorCode.UNKNOWN_CAPABILITY);
    }
  });

  it('still throws for a typo of a real capability, which is the point', () => {
    // 'smee' must not quietly become false just because an escape hatch exists
    // elsewhere in the API. The escape hatch has to be asked for.
    expect(() => caps.has('smee')).toThrowError(CapsError);
    expect(caps.has('smee', { ifUnknown: false })).toBe(false);
  });

  it('detail() has no ifUnknown form, deliberately', () => {
    // detail() returns a record carrying evidence. Handing one back for an id
    // that does not exist would mean inventing the evidence. lookup() returns
    // undefined instead, and the type system enforces the check.
    expect(() => caps.detail('future_feat_xyz')).toThrowError(CapsError);
    expect(caps.lookup('future_feat_xyz')).toBeUndefined();
  });
});

describe('documented ids resolve without an escape hatch', () => {
  it('every documented id resolves through has(), detail() and lookup()', () => {
    const documented = [
      ...DOCUMENTED_LEAVES.map(([id]) => id),
      'metal',
      'amx',
      'sve',
      'sve2',
    ];
    for (const id of documented) {
      expect(() => caps.has(id), id).not.toThrow();
      expect(caps.lookup(id), id).toBeDefined();
      expect(caps.detail(id).id, id).toBe(id);
    }
  });

  it('a documented id resolves to the same answer with or without ifUnknown', () => {
    // If these ever diverged it would mean a documented id had stopped
    // resolving, i.e. the guarantee had quietly become an escape hatch.
    for (const [id] of DOCUMENTED_LEAVES) {
      expect(caps.has(id, { ifUnknown: true }), id).toBe(caps.has(id));
    }
  });
});
