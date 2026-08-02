/**
 * The public surface: the ergonomics, and the honesty underneath them.
 */
import { describe, expect, it } from 'vitest';

import caps, {
  CapsError,
  CapsErrorCode,
  canonicalSnapshot,
  checkConformance,
  detect,
  formatReport,
  idFromLeaf,
  isEnabled,
  normalizeDatatype,
} from '../src/index.js';

describe('has() and detail()', () => {
  it('has() is true only for detected', () => {
    for (const cap of caps.all()) {
      expect(caps.has(cap.id)).toBe(cap.state === 'detected');
    }
  });

  it('has() collapses undetectable to false, and detail() still distinguishes it', () => {
    // Both read false, and that is the documented trade. The difference is one
    // call away and the reason is attached to it.
    expect(caps.has('amx')).toBe(false);
    expect(caps.has('mte')).toBe(false);

    expect(caps.detail('amx').state).toBe('undetectable');
    expect(caps.detail('mte').state).toBe('not-present');

    const amx = caps.detail('amx');
    if (amx.state === 'undetectable') {
      expect(amx.reason.length).toBeGreaterThan(80);
      expect(amx.permanent).toBe(true);
    }

    // And the explicit path still exists for callers who want to state the
    // default at the call site instead of inheriting one.
    expect(isEnabled(caps.detail('amx'), true)).toBe(true);
    expect(isEnabled(caps.detail('amx'), false)).toBe(false);
    expect(isEnabled(caps.detail('mte'), true)).toBe(false);
  });

  it('throws UNKNOWN_CAPABILITY for a typo rather than answering false', () => {
    expect(() => caps.has('smee')).toThrowError(CapsError);
    try {
      caps.has('smee');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapsError);
      expect((err as CapsError).code).toBe(CapsErrorCode.UNKNOWN_CAPABILITY);
      // A typo should get help, not just a rejection.
      expect((err as CapsError).message).toMatch(/Did you mean/);
    }
  });

  it('accepts every spelling of a key a caller might reasonably try', () => {
    const expected = caps.detail('sme2');
    for (const spelling of [
      'sme2',
      'SME2',
      'FEAT_SME2',
      'feat_sme2',
      'arm.FEAT_SME2',
      'hw.optional.arm.FEAT_SME2',
      '  sme2  ',
    ]) {
      expect(caps.detail(spelling).id, spelling).toBe(expected.id);
    }
  });

  it('resolves an id collision deterministically and says that it did', () => {
    // hw.optional.arm.FEAT_AES and hw.optional.aes both normalise to 'aes'. The
    // arm-namespaced key takes the short id; the other keeps its full key as its
    // id rather than being given an invented namespace.
    expect(caps.detail('aes').sysctlKey).toBe('hw.optional.arm.FEAT_AES');
    const other = caps.detail('hw.optional.aes');
    expect(other.sysctlKey).toBe('hw.optional.aes');
    expect(other.id).toBe('hw.optional.aes');
    expect(other.note).toMatch(/already taken/);
  });

  it('idFromLeaf collapses both SME naming schemes onto one id shape', () => {
    expect(idFromLeaf('arm.FEAT_SME_I16I64')).toBe('sme_i16i64');
    expect(idFromLeaf('arm.SME_I8I32')).toBe('sme_i8i32');
    expect(idFromLeaf('neon')).toBe('neon');
  });
});

describe('assertRequired', () => {
  it('does not throw for a capability that is detected', () => {
    expect(() => {
      caps.assertRequired(['neon']);
    }).not.toThrow();
    expect(() => {
      caps.assertRequired(['neon', 'sme']);
    }).not.toThrow();
  });

  it('throws UNKNOWN_CAPABILITY for a bogus capability', () => {
    try {
      caps.assertRequired(['definitely-not-a-real-capability']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapsError);
      expect((err as CapsError).code).toBe(CapsErrorCode.UNKNOWN_CAPABILITY);
    }
  });

  it('throws UNSUPPORTED_PLATFORM with reasons for something not established', () => {
    try {
      caps.assertRequired(['neon', 'amx']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapsError);
      expect((err as CapsError).code).toBe(CapsErrorCode.UNSUPPORTED_PLATFORM);
      expect((err as CapsError).message).toMatch(/amx: undetectable \(permanently\)/);
      // neon was fine, so it must not be listed as a shortfall.
      expect((err as CapsError).message).not.toMatch(/neon:/);
    }
  });

  it('is opt-in: importing the package does not enforce anything', () => {
    // There is no REQUIRED list in this package, so a machine missing every
    // feature still loads and still answers. Proof: the snapshot exists and
    // contains capabilities that were not established.
    expect(caps.all().some((c) => c.state !== 'detected')).toBe(true);
  });
});

describe('SME ergonomics', () => {
  it('accepts both kernel naming schemes for the same question', () => {
    // I8I32 lives under arm.SME_*, I16I64 under arm.FEAT_SME_*. The caller must
    // never have to know that.
    expect(caps.sme.supports('I8I32')).toBe(caps.sme.supports('SME_I8I32'));
    expect(caps.sme.supports('I16I64')).toBe(caps.sme.supports('FEAT_SME_I16I64'));
    expect(caps.sme.supports('i8i32')).toBe(caps.sme.supports('I8I32'));
    expect(caps.sme.supports('hw.optional.arm.SME_I8I32')).toBe(caps.sme.supports('I8I32'));
  });

  it('exposes which scheme answered, for the curious only', () => {
    expect(caps.sme.detail('I8I32').scheme).toBe('short');
    expect(caps.sme.detail('I16I64').scheme).toBe('prefixed');
  });

  it('exposes the datatype matrix as structured data', () => {
    expect(caps.sme.datatypes.length).toBeGreaterThanOrEqual(10);
    for (const dt of caps.sme.datatypes) {
      expect(dt.label).toBe(dt.label.toUpperCase());
      expect(dt.id).toBe(`sme_${dt.label.toLowerCase()}`);
      expect(['detected', 'not-present', 'undetectable']).toContain(dt.state);
    }
  });

  it('documents what I8I32 and I16I64 are actually for', () => {
    expect(caps.sme.detail('I8I32').note).toMatch(/Reed-Solomon/);
    expect(caps.sme.detail('I16I64').note).toMatch(/NTT/);
  });

  it('throws for a datatype it has never heard of', () => {
    expect(() => caps.sme.supports('Q7Q9')).toThrowError(CapsError);
  });

  it('normalizeDatatype strips every prefix the kernel uses', () => {
    expect(normalizeDatatype('FEAT_SME_I16I64')).toBe('i16i64');
    expect(normalizeDatatype('hw.optional.arm.SME_I8I32')).toBe('i8i32');
    expect(normalizeDatatype('i8i32')).toBe('i8i32');
  });
});

describe('determinism', () => {
  it('detect() returns the identical frozen object every time', () => {
    expect(detect()).toBe(caps);
    expect(detect()).toBe(detect());
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.cpu)).toBe(true);
    expect(Object.isFrozen(caps.sme.datatypes)).toBe(true);
    expect(Object.isFrozen(caps.raw())).toBe(true);
    expect(Object.isFrozen(caps.raw().enumerated)).toBe(true);
  });

  it('the raw payload is the same object, so a bug report and the snapshot agree', () => {
    expect(caps.raw()).toBe(detect().raw());
  });

  it('canonicalSnapshot() is sorted, state-only and stable', () => {
    const a = canonicalSnapshot();
    const b = canonicalSnapshot();
    expect(a.digest).toBe(b.digest);
    expect(a.entries).toStrictEqual(b.entries);
    expect([...a.entries]).toStrictEqual([...a.entries].sort());
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);

    // States only. A value would make two identical machines disagree.
    for (const entry of a.entries) {
      expect(entry).toMatch(/=(detected|not-present|undetectable|measured)$/);
    }
    expect(a.entries).toContain('cap.amx=undetectable');
    expect(a.entries).toContain('cap.sme=detected');
  });
});

describe('checkConformance', () => {
  it('finds nothing when a consumer agrees', () => {
    expect(checkConformance({ sme: 'detected', mte: 'not-present' })).toStrictEqual([]);
    expect(checkConformance({ sme: true, mte: false })).toStrictEqual([]);
  });

  it('flags a consumer that disagrees about the same machine', () => {
    const violations = checkConformance({ sme: false });
    expect(violations.length).toBe(1);
    expect(violations[0]?.capability).toBe('sme');
    expect(violations[0]?.canonical).toBe('detected');
  });

  it('flags a boolean report of an undetectable capability with no declared mapping', () => {
    const undeclared = checkConformance({ amx: false });
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]?.explanation).toMatch(/undetectableMapsTo/);

    // Declared, and therefore fine.
    expect(checkConformance({ amx: false }, { undetectableMapsTo: false })).toStrictEqual([]);
    expect(checkConformance({ amx: true }, { undetectableMapsTo: true })).toStrictEqual([]);
  });

  it('flags a capability this package has never heard of', () => {
    const violations = checkConformance({ has_amx_support: true });
    expect(violations[0]?.canonical).toBe('unknown');
  });
});

describe('formatReport', () => {
  const report = formatReport();

  it('shows AMX as undetectable with its reason visible', () => {
    expect(report).toMatch(/amx {2}\[undetectable, permanent, never probed\]/);
    expect(report).toMatch(/no sysctl key and no public API/);
  });

  it('shows evidence next to every verdict, not bare booleans', () => {
    expect(report).toContain('hw.optional.arm.FEAT_SME = 1');
    expect(report).toContain('hw.perflevel0.physicalcpu = 12');
    expect(report).toContain('IORegistry AGXAcceleratorG16X.gpu-core-count');
    expect(report).toContain('MTLCreateSystemDefaultDevice -> "Apple M4 Max"');
  });

  it('explains how to read the three states', () => {
    expect(report).toMatch(/not-present: a source was consulted and said/);
    expect(report).toMatch(/undetectable: nothing was learned/);
  });

  it('never presents the brand string as evidence', () => {
    const evidenceLines = report
      .split('\n')
      .filter((l) => l.includes('detected') || l.includes('not-present'));
    for (const line of evidenceLines) {
      expect(line).not.toContain('machdep.cpu.brand_string');
    }
  });
});
