/**
 * The one hand-written key list left in the TypeScript layer.
 *
 * `DOCUMENTED_LEAVES` is nine entries mapping a documented capability id to the
 * sysctl leaf that answers it. It is the last place in this package where a
 * human typed a kernel key name, and it therefore carries the original defect in
 * miniature: a misspelled leaf never fails loudly. It registers as
 * `undetectable` with a reason saying the name did not appear in the MIB, which
 * is INDISTINGUISHABLE from a real feature whose key this kernel genuinely does
 * not publish. That is `hw.optional.amx_version` again, one directory over.
 *
 * So the list gets a test. THE RULE: a name belongs in DOCUMENTED_LEAVES only if
 * it can be verified to resolve on a machine you have. This file is that
 * verification for this machine, and it is why the list stops at nine rather
 * than covering the whole published FEAT_* space.
 */
import { describe, expect, it } from 'vitest';

import caps, { DOCUMENTED_LEAVES, idFromLeaf } from '../src/index.js';

/** Every key the KERNEL produced, by any route. Nothing hardcoded. */
const kernelKeys = new Set<string>([
  ...caps.raw().enumerated.map(([key]) => key),
  ...caps.raw().unreadableKeys.map(([key]) => key),
]);

/** Keys the kernel produced a VALUE for, i.e. readable, not just published. */
const readableKeys = new Set<string>(caps.raw().enumerated.map(([key]) => key));

const root = `${caps.raw().enumerationRoot}.`;

describe('DOCUMENTED_LEAVES', () => {
  it('is the nine entries the package documents, with no duplicates', () => {
    expect(DOCUMENTED_LEAVES.length).toBe(9);
    expect(new Set(DOCUMENTED_LEAVES.map(([id]) => id)).size).toBe(9);
    expect(new Set(DOCUMENTED_LEAVES.map(([, leaf]) => leaf)).size).toBe(9);
  });

  it('declares ids that match what the leaf would normalise to anyway', () => {
    // If these disagreed, the id would be an invented label rather than a
    // spelling of the kernel's own name, and the mapping table would start
    // carrying meaning that no kernel published.
    for (const [id, leaf] of DOCUMENTED_LEAVES) {
      expect(idFromLeaf(leaf), leaf).toBe(id);
    }
  });

  it.each([...DOCUMENTED_LEAVES])(
    "'%s' resolves to a key this kernel actually published",
    (id, leaf) => {
      const key = root + leaf;
      const detail = caps.detail(id);

      // The id always resolves - that is the stability guarantee - so resolving
      // proves nothing on its own. What matters is WHICH key answered and
      // whether the kernel has ever heard of it.
      expect(detail.sysctlKey, id).toBe(key);

      if (!kernelKeys.has(key)) {
        throw new Error(
          `DOCUMENTED_LEAVES entry ['${id}', '${leaf}'] names '${key}', which is ` +
            `NOT among the ${kernelKeys.size} keys this kernel published under ` +
            `${caps.raw().enumerationRoot}. The capability is therefore reported ` +
            `as permanently 'undetectable' and NOTHING distinguishes that from a ` +
            `real feature whose key this kernel does not publish. Either the leaf ` +
            `is misspelled, or it does not belong in this list: a name only ` +
            `belongs there if it can be verified to resolve on a machine you have.`,
        );
      }
    },
  );

  it.each([...DOCUMENTED_LEAVES])(
    "'%s' is not undetectable-due-to-missing-key on this machine",
    (id, leaf) => {
      const key = root + leaf;
      const detail = caps.detail(id);

      // All nine are readable here, so all nine must carry a real answer with
      // sysctl evidence. An 'undetectable' here would mean the leaf never showed
      // up in the walk, which is the failure the message above describes.
      expect(readableKeys.has(key), key).toBe(true);
      expect(detail.state, id).not.toBe('undetectable');
      if (detail.state !== 'undetectable') {
        expect(detail.evidence.kind, id).toBe('sysctl');
        if (detail.evidence.kind === 'sysctl') {
          expect(detail.evidence.key, id).toBe(key);
          expect(detail.evidence.valueText, id).not.toBe('');
        }
      }
    },
  );

  it('resolves all nine without an ifUnknown escape hatch', () => {
    // The documented set is exactly the set a cross-platform caller may address
    // with a bare has(). If that stopped being true the guarantee would be gone.
    for (const [id] of DOCUMENTED_LEAVES) {
      expect(() => caps.has(id), id).not.toThrow();
    }
  });
});
