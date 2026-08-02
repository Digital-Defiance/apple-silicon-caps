/**
 * The state distinction, exercised against real kernel data rather than asserted.
 *
 * It would be easy to write a suite where every state came from a fixture. Then
 * the mapping would be tested and the plumbing would not. These tests insist that
 * this machine actually produced each state.
 */
import { describe, expect, it } from 'vitest';

import caps, { ENOTSUP, isEnabled } from '../src/index.js';

describe('not-present from a key that exists and reported zero', () => {
  const zeroValued = caps
    .all()
    .filter((c) => c.state === 'not-present')
    .filter((c) => c.state === 'not-present' && c.evidence.kind === 'sysctl');

  it('there is at least one, so not-present is not a theoretical state', () => {
    expect(zeroValued.length).toBeGreaterThan(0);
  });

  it('each one carries the zero the kernel actually returned', () => {
    for (const cap of zeroValued) {
      if (cap.state !== 'not-present' || cap.evidence.kind !== 'sysctl') continue;
      expect(cap.evidence.value).toBe(0);
      expect(cap.evidence.valueText).toBe('0');
      expect(cap.evidence.key).toBe(cap.sysctlKey);
    }
  });

  it('a specific one: FEAT_MTE is published here and reports 0', () => {
    const mte = caps.detail('mte');
    expect(mte.state).toBe('not-present');
    expect(mte.sysctlKey).toBe('hw.optional.arm.FEAT_MTE');
    if (mte.state === 'not-present' && mte.evidence.kind === 'sysctl') {
      expect(mte.evidence.value).toBe(0);
    }
    // The distinction that matters: this is a real answer, so collapsing it to
    // false is correct, and it is NOT the same as amx.
    expect(caps.has('mte')).toBe(false);
    expect(isEnabled(mte, true)).toBe(false);
    expect(isEnabled(caps.detail('amx'), true)).toBe(true);
  });
});

describe('ENOTSUP and ENOENT are not the same fact', () => {
  it('a real ENOTSUP key on this kernel is not-present, with the errno as evidence', () => {
    // hw.optional.avx512f is published in this arm64 kernel's MIB and the kernel
    // declines to answer for this architecture. Measured, not assumed: 29 keys
    // behave this way here.
    const declined = caps.detail('avx512f');
    expect(declined.state).toBe('not-present');
    if (declined.state === 'not-present') {
      expect(declined.evidence.kind).toBe('kernel-declined');
      if (declined.evidence.kind === 'kernel-declined') {
        expect(declined.evidence.errno).toBe(ENOTSUP);
        expect(declined.evidence.errnoName).toBe('ENOTSUP');
      }
    }
  });

  it('all 29 unreadable names on this kernel are ENOTSUP, none are ENOENT', () => {
    const raw = caps.raw();
    expect(raw.unreadableKeys.length).toBeGreaterThan(0);
    for (const [, errno] of raw.unreadableKeys) {
      expect(errno).toBe(ENOTSUP);
    }
  });

  it('a name the kernel never published is undetectable, not not-present', () => {
    // FEAT_SVE is established as absent by the WALK, never by a query. That
    // proves the key is unpublished; it does not establish anything about the
    // silicon, so the state is undetectable.
    const sve = caps.detail('sve');
    expect(sve.state).toBe('undetectable');
    expect(sve.probed).toBe(false);
    expect(caps.raw().sveTrap.bareSveKeyPresent).toBe(false);
    expect(caps.raw().sveTrap.sve2KeyPresent).toBe(false);
  });

  it('the SVE prefix trap is present on this machine, and is not fallen into', () => {
    // FEAT_SVE_B16B16 exists and reports 0. A substring match on "SVE" finds it
    // and concludes SVE support. Exact matching means sve stays undetectable
    // while sve_b16b16 is separately not-present.
    const sveish = caps.raw().sveTrap.keysContainingSve;
    expect(sveish.length).toBeGreaterThan(0);
    expect(caps.detail('sve_b16b16').state).toBe('not-present');
    expect(caps.detail('sve').state).toBe('undetectable');
  });
});

describe('the brand string is never evidence', () => {
  const brandKey = caps.raw().cpuBrandStringKey;

  it('no capability cites it', () => {
    expect(brandKey).toBe('machdep.cpu.brand_string');
    for (const cap of caps.all()) {
      expect(cap.sysctlKey).not.toBe(brandKey);
      if (cap.state !== 'undetectable' && 'key' in cap.evidence) {
        expect(cap.evidence.key).not.toBe(brandKey);
      }
    }
  });

  it('no numeric reading cites it', () => {
    const readings = [
      ...Object.values(caps.cpu.readings),
      ...Object.values(caps.cache.readings),
      ...Object.values(caps.memory.readings),
      caps.gpu.readings.cores,
      caps.sme.svl,
    ];
    for (const reading of readings) {
      if (reading.state === 'measured' && 'key' in reading.evidence) {
        expect(reading.evidence.key).not.toBe(brandKey);
      }
    }
  });

  it('is carried with its own warning attached', () => {
    expect(caps.chip).not.toBeNull();
    expect(caps.chipWarning).toMatch(/informational only/i);
    expect(caps.chipWarning).toMatch(/brand-string inference/i);
  });
});
