/**
 * AMX.
 *
 * The original defect in one capability: node-fhe-accelerate queried
 * `hw.optional.amx_version`, a key that does not exist, and read the failure as
 * "AMX absent". The fix is not a better query. There is no query. This file
 * proves the absence of the query, not the correctness of its result.
 */
import { describe, expect, it } from 'vitest';

import caps, { queriedSysctlKeys } from '../src/index.js';

describe('amx', () => {
  it('is undetectable and permanently so', () => {
    const amx = caps.detail('amx');
    expect(amx.state).toBe('undetectable');
    if (amx.state !== 'undetectable') return;
    expect(amx.permanent).toBe(true);
    expect(amx.reason).toMatch(/no sysctl key and no public API/i);
    expect(amx.reason).toMatch(/no key containing "amx" is ever queried/i);
  });

  it('can never be reported as detected or not-present', () => {
    // Exhaustive over the state type: there is no fourth inhabitant.
    for (const forbidden of ['detected', 'not-present'] as const) {
      expect(caps.detail('amx').state).not.toBe(forbidden);
    }
    expect(caps.has('amx')).toBe(false);
  });

  it('is marked as never probed, so the absence of a query is machine-readable', () => {
    expect(caps.detail('amx').probed).toBe(false);
    expect(caps.detail('amx').sysctlKey).toBeNull();
    expect(caps.raw().amx.probed).toBe(false);
  });

  it('no key containing "amx" is queried by name', () => {
    for (const key of queriedSysctlKeys()) {
      expect(key.toLowerCase()).not.toContain('amx');
    }
  });

  it('no key containing "amx" appears anywhere a value was read', () => {
    // The native MIB walk discovers names BEFORE reading values and skips any
    // name containing "amx" before the read, so an AMX value cannot exist in
    // this process. This asserts the observable consequence of that ordering.
    const raw = caps.raw();
    for (const [key] of raw.enumerated) {
      expect(key.toLowerCase()).not.toContain('amx');
    }
    for (const [key] of raw.namedProbes) {
      expect(key.toLowerCase()).not.toContain('amx');
    }
    for (const [key] of raw.unreadableKeys) {
      expect(key.toLowerCase()).not.toContain('amx');
    }
  });

  it('no capability cites an amx key as evidence', () => {
    for (const cap of caps.all()) {
      if (cap.sysctlKey !== null) {
        expect(cap.sysctlKey.toLowerCase()).not.toContain('amx');
      }
      if (cap.state !== 'undetectable' && 'key' in cap.evidence) {
        expect(cap.evidence.key.toLowerCase()).not.toContain('amx');
      }
    }
  });

  it('names the phantom keys as documentation without ever querying them', () => {
    const phantoms = caps.raw().phantomKeysNeverQueried;
    expect(phantoms).toContain('hw.optional.amx_version');
    for (const phantom of phantoms) {
      expect(queriedSysctlKeys()).not.toContain(phantom);
    }
  });
});
