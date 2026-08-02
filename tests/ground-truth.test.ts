/**
 * Measured ground truth for the machine this package was developed on.
 *
 * Guarded on the brand string so it SKIPS everywhere else. Note the one place
 * the brand string is allowed to appear: choosing whether to run a test. It is
 * still not evidence for any capability — it only decides whether this file's
 * expectations apply.
 */
import { describe, expect, it } from 'vitest';

import caps from '../src/index.js';

const isM4Max = caps.chip === 'Apple M4 Max';

describe.runIf(isM4Max)('M4 Max ground truth', () => {
  it('detects the CPU features whose keys exist and report non-zero', () => {
    for (const feature of [
      'neon',
      'sme',
      'sme2',
      'bf16',
      'i8mm',
      'dotprod',
      'fp16',
      'lse',
      'sha3',
    ] as const) {
      expect(caps.detail(feature).state, feature).toBe('detected');
      expect(caps.has(feature), feature).toBe(true);
    }
  });

  it('reads SME streaming vector length as 512 bits / 64 bytes', () => {
    expect(caps.sme.svlBits).toBe(512);
    expect(caps.sme.svlBytes).toBe(64);
    expect(caps.sme.available).toBe(true);
    expect(caps.sme.sme2).toBe(true);
    expect(caps.sme.sme2p1).toBe(false);
  });

  it('supports the datatypes an RS kernel and a matrix NTT need', () => {
    expect(caps.sme.supports('I8I32')).toBe(true);
    expect(caps.sme.supports('I16I64')).toBe(true);
    // Published under the OTHER naming scheme, and reporting 0. Both facts are
    // visible; neither is smoothed over.
    expect(caps.sme.supports('F16F16')).toBe(false);
    expect(caps.sme.detail('F16F16').state).toBe('not-present');
  });

  it('measures 40 GPU cores from the IORegistry, not from a chip table', () => {
    expect(caps.gpu.cores).toBe(40);
    expect(caps.gpu.metal).toBe(true);
    const reading = caps.gpu.readings.cores;
    expect(reading.state).toBe('measured');
    if (reading.state === 'measured') {
      expect(reading.evidence.kind).toBe('ioregistry');
      if (reading.evidence.kind === 'ioregistry') {
        expect(reading.evidence.property).toBe('gpu-core-count');
        // The concrete class is a subclass; matching on the base class is what
        // makes this work across parts.
        expect(reading.evidence.matchedClass).toMatch(/^AGXAccelerator/);
      }
    }
  });

  it('reads the topology from real keys', () => {
    expect(caps.cpu.performanceCores).toBe(12);
    expect(caps.cpu.efficiencyCores).toBe(4);
    expect(caps.cpu.physicalCores).toBe(16);
    expect(caps.cache.lineSize).toBe(128);
    expect(caps.memory.bytes).toBe(68719476736);
  });

  it('reads cache sizes at the widths the kernel actually publishes', () => {
    expect(caps.cache.l1d).toBe(65536);
    expect(caps.cache.l1i).toBe(131072);
    expect(caps.cache.l2).toBe(4194304);
    // These four are published as 8-byte values on this kernel, including
    // hw.cachelinesize. Reading them as 4 would work by accident on
    // little-endian and break the moment anything else changed.
    for (const reading of [
      caps.cache.readings.l1d,
      caps.cache.readings.l1i,
      caps.cache.readings.l2,
      caps.cache.readings.lineSize,
    ]) {
      expect(reading.state).toBe('measured');
      if (reading.state === 'measured' && reading.evidence.kind === 'sysctl') {
        expect(reading.evidence.widthBytes).toBe(8);
      }
    }
  });

  it('reports 18 keys that exist and say zero, and 29 the kernel declines', () => {
    // The two populations that make the three-state model non-theoretical here.
    const zeros = caps
      .all()
      .filter((c) => c.state === 'not-present' && c.evidence.kind === 'sysctl');
    const declined = caps
      .all()
      .filter((c) => c.state === 'not-present' && c.evidence.kind === 'kernel-declined');
    expect(zeros.length).toBe(18);
    expect(declined.length).toBe(29);
  });
});

describe.skipIf(isM4Max)('non-M4-Max machine', () => {
  it('skipped the ground-truth expectations, and says so', () => {
    // Kept so a run on another machine records WHY the numbers were not checked
    // rather than silently reporting a smaller suite.
    expect(caps.chip).not.toBe('Apple M4 Max');
  });
});
