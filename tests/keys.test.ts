/**
 * Do the keys this package names actually exist?
 *
 * This is the non-vacuous guard in the suite. A hardcoded key name that does not
 * exist is exactly the `hw.optional.amx_version` / `FEAT_SVE2` defect: the query
 * fails, the failure looks like "feature absent", and nobody notices for two
 * years. The key list is read out of the ADDON rather than copied here, so a key
 * added to caps.mm is covered automatically and a hardcoded copy cannot drift.
 */
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import caps, { queriedSysctlKeys } from '../src/index.js';

const namedKeys = queriedSysctlKeys();

describe('named sysctl keys', () => {
  it('names at least one key', () => {
    expect(namedKeys.length).toBeGreaterThan(0);
  });

  it.each([...namedKeys])('%s exists in the sysctl MIB', (key) => {
    let output: string;
    try {
      output = execFileSync('sysctl', ['-n', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error(
        `Named sysctl key '${key}' DOES NOT EXIST on this machine. A query ` +
          `against it fails, and a failed query is indistinguishable from ` +
          `"feature absent" to any caller that collapses the two. Either the ` +
          `key is misspelled in caps.mm, or the thing it describes belongs in ` +
          `the never-probed set alongside amx.`,
      );
    }
    expect(output).not.toBe('');
  });

  it('never names a key known not to exist on Apple Silicon', () => {
    for (const phantom of [
      'hw.optional.amx_version',
      'hw.optional.arm.FEAT_SVE',
      'hw.optional.arm.FEAT_SVE2',
    ]) {
      expect(namedKeys).not.toContain(phantom);
    }
  });

  it('every capability that claims a sysctl key claims one the kernel produced', () => {
    // Capabilities are built from the MIB WALK, so their keys came from the
    // kernel by construction. What this checks is the assembly: that no id was
    // registered pointing at a key the payload does not contain.
    const raw = caps.raw();
    const kernelKeys = new Set<string>([
      ...raw.enumerated.map(([k]) => k),
      ...raw.unreadableKeys.map(([k]) => k),
      ...raw.namedProbes.map(([k]) => k),
    ]);

    for (const cap of caps.all()) {
      if (cap.sysctlKey === null) continue;
      if (cap.state === 'undetectable') continue; // documented id, key not in this MIB
      expect(kernelKeys.has(cap.sysctlKey)).toBe(true);
    }
  });
});

describe('the enumerated surface', () => {
  /**
   * THIS TEST CANNOT MEANINGFULLY FAIL, AND IT IS KEPT ANYWAY.
   *
   * Every name in the enumerated surface came out of a walk of the kernel's own
   * MIB, so it is real by construction; asserting that the list is non-empty
   * cannot catch a phantom key, because a phantom key can never get into the
   * list in the first place. That is the whole reason the enumeration exists.
   *
   * It is kept because it does catch one thing that is not vacuous: total
   * failure. If `Name2Oid`, `OidNext` or `Oid2Name` stop working — a kernel
   * change, a sandbox, a botched build — the walk returns nothing, every
   * capability silently becomes undetectable, and the package would still load
   * and still answer. An empty surface is that failure, and it is worth one
   * assertion. It is a smoke test, not a correctness guard, and it is labelled
   * as one so nobody mistakes it for the key-existence test above.
   */
  it('is non-empty and the walk reported success', () => {
    const raw = caps.raw();
    expect(raw.enumerationOk).toBe(true);
    expect(raw.enumerated.length).toBeGreaterThan(0);
    expect(raw.mibNamesDiscovered).toBeGreaterThanOrEqual(raw.enumerated.length);
  });

  it('produced more addressable capabilities than the package hardcodes', () => {
    // A real consequence of discovery: the catalogue is bigger than any list
    // anyone wrote. If this ever inverts, discovery has stopped working.
    expect(caps.ids().length).toBeGreaterThan(50);
  });
});
