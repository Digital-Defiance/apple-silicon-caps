/**
 * The capability catalogue.
 *
 * Almost every entry here is DISCOVERED, not declared. The native layer walks
 * the `hw.optional` MIB subtree and reports whatever it finds; this file turns
 * each discovered name into an addressable capability id. A discovered name
 * cannot be a phantom, which is why the hardcoded part of this file is kept as
 * small as it is: exactly the ids this package documents in its typings, plus
 * the three capabilities that have no key to discover.
 */
import { CapsError, CapsErrorCode } from './errors.js';
import type { NativePayload } from './native.js';
import {
  type Capability,
  type CapabilityState,
  type Detected,
  type NotPresent,
  type Undetectable,
  mapProbe,
} from './state.js';

/**
 * Where a capability came from. Purely for grouping a report; no claim about
 * silicon is made by any of these labels.
 *
 * - `cpu.arm`     a key under `hw.optional.arm.*`
 * - `cpu.other`   a key under `hw.optional.*` outside the arm namespace
 * - `gpu`         answered by Metal
 * - `unknowable`  no key exists to query, so nothing is queried
 */
export type CapabilityGroup = 'cpu.arm' | 'cpu.other' | 'gpu' | 'unknowable';

export interface CapabilityMeta {
  /** Stable, lowercase, addressable id. */
  readonly id: string;
  /** The sysctl key that answered, or `null` when no key was consulted. */
  readonly sysctlKey: string | null;
  readonly group: CapabilityGroup;
  /** Other names `has()` / `detail()` accept for this capability. */
  readonly aliases: readonly string[];
  /** False only for capabilities this package refuses to query. */
  readonly probed: boolean;
  /** Human-facing note, when there is something worth saying. */
  readonly note: string | null;
}

/** A capability with its state, its evidence and its identity. */
export type CapabilityDetail =
  | (CapabilityMeta & Detected)
  | (CapabilityMeta & NotPresent)
  | (CapabilityMeta & Undetectable);

/**
 * The capability ids this package documents and guarantees exist on every
 * machine, whatever the answer turns out to be. Any other id is discovered
 * from the kernel and may legitimately not exist elsewhere.
 */
export type DocumentedCapability =
  | 'neon'
  | 'sme'
  | 'sme2'
  | 'bf16'
  | 'i8mm'
  | 'dotprod'
  | 'fp16'
  | 'lse'
  | 'sha3'
  | 'metal'
  | 'amx'
  | 'sve'
  | 'sve2';

/**
 * Any capability id. The documented ones autocomplete; discovered ones are
 * still accepted, because the catalogue is bigger than the documented set on
 * every real machine.
 */
export type CapabilityId = DocumentedCapability | (string & {});

/**
 * Opt-in, non-throwing handling of an id that nothing answers to.
 *
 * Passing this to `has()` is the caller saying, at the call site, "this id may
 * legitimately not exist on every machine, and here is what I want when it
 * does not". Omitting it keeps the throw, which is what makes a typo a bug
 * rather than a permanent false.
 *
 * WHY THIS EXISTS. Only the ~13 documented ids are guaranteed to resolve; the
 * other ~105 on this M4 Max are DISCOVERED from this kernel's MIB. So
 * `has('cssc')` answers here (the kernel publishes FEAT_CSSC and reports 0) and
 * would THROW on a machine whose kernel does not publish that name. Code
 * written as `if (caps.has('cssc'))` therefore works on one Mac and crashes on
 * another. `has('cssc', { ifUnknown: false })` is portable and still says out
 * loud which way the unknown case falls.
 */
export interface IfUnknown {
  /** What `has()` returns when the id resolves to nothing. */
  readonly ifUnknown: boolean;
}

/**
 * The only hardcoded key list in the TypeScript layer, and it is a stability
 * guarantee rather than a detection mechanism: these ids resolve on every
 * machine, so cross-platform callers can ask about them without a try/catch.
 * Each maps to the leaf name (below `hw.optional.`) that answers it.
 *
 * When the leaf is not in this kernel's MIB at all, the capability is
 * registered as `undetectable`. It is never registered as `not-present`,
 * because a name that was never published tells you nothing.
 *
 * THE RULE FOR ADDING TO THIS LIST: a name belongs here only if it has been
 * VERIFIED TO RESOLVE on a machine you have in front of you. Nothing else does.
 * A typo here does not fail loudly, it becomes a permanent `undetectable` that
 * no test and no consumer can tell apart from a genuinely absent feature —
 * which is `hw.optional.amx_version` wearing a different hat. That is why
 * tests/documented-leaves.test.ts asserts every entry resolves to a key the
 * kernel actually produced, and why the list stops at nine.
 *
 * THE OPTION THAT WAS CONSIDERED AND REJECTED. The obvious-looking fix for
 * cross-version portability is to hardcode the full published FEAT_* name space
 * here so that every such id always resolves. It is rejected for the reason
 * above, multiplied by a few hundred: each unverifiable entry is a fresh chance
 * to mint a permanent `undetectable` from a misspelling, and the list would have
 * to be maintained against kernels its author cannot run. Portability is served
 * instead by `lookup()` and by `has(id, { ifUnknown })` in snapshot.ts, which
 * push the decision to the call site, where the caller knows what they want and
 * a typo still surfaces as an error on the bare `has(id)` path.
 */
export const DOCUMENTED_LEAVES: readonly (readonly [id: string, leaf: string])[] = [
  ['neon', 'neon'],
  ['sme', 'arm.FEAT_SME'],
  ['sme2', 'arm.FEAT_SME2'],
  ['bf16', 'arm.FEAT_BF16'],
  ['i8mm', 'arm.FEAT_I8MM'],
  ['dotprod', 'arm.FEAT_DotProd'],
  ['fp16', 'arm.FEAT_FP16'],
  ['lse', 'arm.FEAT_LSE'],
  ['sha3', 'arm.FEAT_SHA3'],
];

/**
 * Convenience spellings that the normaliser cannot derive. Kept deliberately
 * short: the normaliser already collapses `hw.optional.arm.FEAT_SME2` and
 * `FEAT_SME2` and `SME2` onto `sme2` without help.
 */
const EXTRA_ALIASES: readonly (readonly [alias: string, id: string])[] = [
  ['avx', 'avx1_0'],
  ['avx2', 'avx2_0'],
  ['sse41', 'sse4_1'],
  ['sse42', 'sse4_2'],
  ['ssse3', 'supplementalsse3'],
  ['simd', 'advsimd'],
];

/**
 * Explains an id that is a full sysctl key rather than a short name. See the
 * collision rule in `buildCatalogue`.
 */
function collisionNote(id: string, key: string, natural: string): string | null {
  return id === key
    ? `Registered under its full key: the short id '${natural}' was already ` +
        `taken by a key in the hw.optional.arm namespace. No namespace was ` +
        `invented for this one, because inventing one would mean asserting what ` +
        `the key is for, and this package does not know that.`
    : null;
}

/**
 * Leaf name -> capability id.
 *
 * `arm.FEAT_SME2` -> `sme2`, `arm.SME_I8I32` -> `sme_i8i32`,
 * `arm.FEAT_SME_I16I64` -> `sme_i16i64`, `neon_fp16` -> `neon_fp16`.
 *
 * Note what falls out of this for free: the kernel's two SME naming schemes
 * (`arm.SME_I8I32` short-form and `arm.FEAT_SME_I16I64` prefixed) collapse onto
 * the SAME `sme_<datatype>` id shape. The caller never has to know which scheme
 * their datatype happens to live in, and no mapping table encodes the split.
 */
export function idFromLeaf(leaf: string): string {
  let s = leaf;
  if (s.startsWith('arm.')) s = s.slice(4);
  if (s.startsWith('FEAT_')) s = s.slice(5);
  return s.toLowerCase();
}

/**
 * Normalise caller input to the same shape `idFromLeaf` produces.
 *
 * Case-insensitive on the prefixes, unlike `idFromLeaf`, because kernel leaves
 * arrive correctly cased and human input does not. `feat_sme2`, `FEAT_SME2`,
 * `arm.FEAT_SME2` and `hw.optional.arm.FEAT_SME2` all land on `sme2`.
 */
function normalizeQuery(name: string): string {
  let s = name.trim().replace(/-/g, '_');
  if (/^hw\.optional\./i.test(s)) s = s.slice('hw.optional.'.length);
  if (/^arm\./i.test(s)) s = s.slice('arm.'.length);
  if (/^feat_/i.test(s)) s = s.slice('FEAT_'.length);
  return s.toLowerCase();
}

/** `sme_i8i32` -> `i8i32`, so a bare datatype name is also addressable. */
const DATATYPE_SUFFIX = /^sme_([a-z]{1,2}\d{1,2}[a-z]{1,2}\d{1,2})$/;

export interface Catalogue {
  readonly entries: readonly CapabilityDetail[];
  /** Keys found in the MIB whose value is not a scalar, so not a capability. */
  readonly nonScalarKeys: readonly (readonly [key: string, widthBytes: number, hex: string])[];
  resolve(name: string): CapabilityDetail | undefined;
}

function metaOf(
  id: string,
  sysctlKey: string | null,
  group: CapabilityGroup,
  aliases: readonly string[],
  probed: boolean,
  note: string | null,
): CapabilityMeta {
  return { id, sysctlKey, group, aliases, probed, note };
}

function withMeta(meta: CapabilityMeta, cap: Capability): CapabilityDetail {
  switch (cap.state) {
    case 'detected':
      return { ...meta, state: 'detected', evidence: cap.evidence };
    case 'not-present':
      return { ...meta, state: 'not-present', evidence: cap.evidence };
    default:
      return { ...meta, state: 'undetectable', reason: cap.reason, permanent: cap.permanent };
  }
}

/**
 * Build the catalogue from a raw payload.
 *
 * Registration order is fixed so that ids are deterministic for a given
 * payload:
 *
 *   1. enumerated keys under `hw.optional.arm.*`, in kernel order
 *   2. enumerated keys elsewhere under `hw.optional.*`, in kernel order
 *   3. keys found in the MIB but unreadable, in kernel order
 *   4. documented ids whose leaf never appeared
 *   5. capabilities with no key to query
 *
 * Step 1 before step 2 settles the one real id collision on this kernel:
 * `hw.optional.arm.FEAT_AES` and `hw.optional.aes` both normalise to `aes`.
 * The arm-namespaced key takes the short id; the loser is registered under its
 * FULL KEY (`hw.optional.aes`) rather than under a made-up label like `x86.aes`,
 * because inventing a namespace would mean asserting what the key is for, and
 * this package does not know that.
 */
export function buildCatalogue(raw: NativePayload): Catalogue {
  const entries: CapabilityDetail[] = [];
  const byId = new Map<string, CapabilityDetail>();
  const byKey = new Map<string, CapabilityDetail>();
  const aliasTo = new Map<string, string>();
  const nonScalarKeys: (readonly [string, number, string])[] = [];
  const root = raw.enumerationRoot + '.';

  const register = (entry: CapabilityDetail): void => {
    entries.push(entry);
    byId.set(entry.id, entry);
    if (entry.sysctlKey !== null) byKey.set(entry.sysctlKey, entry);
    for (const alias of entry.aliases) {
      if (!aliasTo.has(alias)) aliasTo.set(alias, entry.id);
    }
  };

  const leafOf = (key: string): string => (key.startsWith(root) ? key.slice(root.length) : key);

  const aliasesFor = (id: string): string[] => {
    const m = DATATYPE_SUFFIX.exec(id);
    return m?.[1] !== undefined ? [m[1]] : [];
  };

  // --- 1 & 2: readable enumerated keys ------------------------------------
  const armFirst = [
    ...raw.enumerated.filter(([key]) => leafOf(key).startsWith('arm.')),
    ...raw.enumerated.filter(([key]) => !leafOf(key).startsWith('arm.')),
  ];

  for (const [key, value, widthBytes, hex] of armFirst) {
    if (value === '') {
      // Present, readable, and not a scalar: `hw.optional.arm.caps` is a
      // 12-byte undocumented blob. It is reported raw and never decoded, so it
      // is not a capability and does not get an id. Decoding an undocumented
      // bitfield is guessing with extra steps.
      nonScalarKeys.push([key, widthBytes, hex]);
      continue;
    }
    const leaf = leafOf(key);
    const natural = idFromLeaf(leaf);
    const id = byId.has(natural) ? key : natural;
    const group: CapabilityGroup = leaf.startsWith('arm.') ? 'cpu.arm' : 'cpu.other';
    // Not everything under hw.optional is a flag. hw.optional.watchpoint is 4,
    // hw.optional.breakpoint is 6, hw.optional.arm.sme_max_svl_b is 64. Those
    // are counts, and `detected` for them means only "non-zero". Saying so
    // beats letting someone read has('watchpoint') as a yes/no about debug
    // support when the number is the actual answer.
    const countNote =
      value !== '0' && value !== '1'
        ? `This key publishes a COUNT (${value}), not a 0/1 flag. 'detected' ` +
          `here means only that it is non-zero; the value is the answer, and it ` +
          `is on the evidence.`
        : null;
    register(
      withMeta(
        metaOf(
          id,
          key,
          group,
          aliasesFor(id),
          true,
          collisionNote(id, key, natural) ?? countNote,
        ),
        mapProbe({ key, outcome: value !== '0' ? 1 : 0, value, widthBytes, errno: 0, strerror: '' }),
      ),
    );
  }

  // --- 3: names in the MIB that produced no value -------------------------
  for (const [key, errno, strerror] of raw.unreadableKeys) {
    const leaf = leafOf(key);
    const natural = idFromLeaf(leaf);
    const id = byId.has(natural) ? key : natural;
    const group: CapabilityGroup = leaf.startsWith('arm.') ? 'cpu.arm' : 'cpu.other';
    register(
      withMeta(
        metaOf(id, key, group, aliasesFor(id), true, collisionNote(id, key, natural)),
        mapProbe({ key, outcome: -1, value: '', widthBytes: 0, errno, strerror }),
      ),
    );
  }

  // --- 4: documented ids whose leaf never appeared -------------------------
  for (const [id, leaf] of DOCUMENTED_LEAVES) {
    if (byId.has(id)) continue;
    const key = root + leaf;
    register(
      withMeta(
        metaOf(id, key, leaf.startsWith('arm.') ? 'cpu.arm' : 'cpu.other', [], true, null),
        {
          state: 'undetectable',
          reason:
            `'${key}' did not appear in the ${raw.mibNamesDiscovered} names ` +
            `discovered under ${raw.enumerationRoot}, so no value was obtained ` +
            `and nothing was learned. This id is documented and therefore ` +
            `always resolves; the answer here is ignorance, not absence.`,
          permanent: false,
        },
      ),
    );
  }

  // --- 5: capabilities with no key to query -------------------------------
  register(
    withMeta(
      metaOf(
        'amx',
        null,
        'unknowable',
        [],
        false,
        'Never probed, by construction. See the reason field.',
      ),
      {
        state: 'undetectable',
        permanent: true,
        reason:
          'Apple publishes no sysctl key and no public API for the AMX matrix ' +
          'coprocessor. It is not user-space programmable; code reaches it, if ' +
          'at all, only as an internal implementation detail of the Accelerate ' +
          'framework, which this package cannot observe. hw.optional.amx_version ' +
          'does not exist in the MIB. No key containing "amx" is ever queried by ' +
          'this package: the native MIB walk discovers names before reading ' +
          'values and skips any name containing "amx" before its value is read, ' +
          'so no AMX value can exist in this process. Any true/false answer ' +
          'would be a guess, and "false" is the guess that has already been ' +
          'shipped four times.',
      },
    ),
  );

  const sveAbsenceReason = (key: string, alsoNote: string): string =>
    `'${key}' did not appear in the ${raw.mibNamesDiscovered} names discovered ` +
    `under ${raw.enumerationRoot}, and this package never queried it. ${alsoNote} ` +
    `Absence from a complete walk proves the KEY is not published; it does not ` +
    `by itself establish anything about the silicon, so this is reported as ` +
    `undetectable rather than not-present. Note the trap: ` +
    `hw.optional.arm.FEAT_SVE_B16B16 DOES exist here and reports 0, so a prefix ` +
    `or substring match on "SVE" finds a key and concludes support. Match exactly.`;

  register(
    withMeta(
      metaOf('sve', null, 'unknowable', [], false, 'Never probed. Absence read off the walk.'),
      {
        state: 'undetectable',
        permanent: false,
        reason: sveAbsenceReason(
          'hw.optional.arm.FEAT_SVE',
          "Apple's SME implementation is streaming-only and no Apple part to " +
            'date has published a plain-SVE key; if one ever does, this becomes ' +
            'detectable. Callers wanting vector width should ask about sme and ' +
            'read sme.svlBits.',
        ),
      },
    ),
  );

  register(
    withMeta(
      metaOf('sve2', null, 'unknowable', [], false, 'Never probed. Absence read off the walk.'),
      {
        state: 'undetectable',
        permanent: false,
        reason: sveAbsenceReason(
          'hw.optional.arm.FEAT_SVE2',
          'Previously queried by node-zk-accelerate, whose failed query was ' +
            "misread as 'feature absent'.",
        ),
      },
    ),
  );

  const deviceName = raw.metalDeviceName === '' ? null : raw.metalDeviceName;
  register(
    withMeta(
      metaOf('metal', null, 'gpu', [], true, null),
      raw.metalAvailable
        ? {
            state: 'detected',
            evidence: { kind: 'metal', api: raw.metalApi, deviceName },
          }
        : {
            state: 'not-present',
            evidence: { kind: 'metal', api: raw.metalApi, deviceName: null },
          },
    ),
  );

  for (const [alias, id] of EXTRA_ALIASES) {
    if (byId.has(id) && !aliasTo.has(alias) && !byId.has(alias)) aliasTo.set(alias, id);
  }

  const resolve = (name: string): CapabilityDetail | undefined => {
    const raw0 = name.trim();
    // Exact id first, then exact full key, then the alias table, then the
    // normalised form. Full-key lookup before normalisation is what makes
    // `hw.optional.aes` resolve to the non-arm key rather than being
    // normalised onto `aes` and landing on the arm one.
    const byExactId = byId.get(raw0);
    if (byExactId !== undefined) return byExactId;
    const byExactKey = byKey.get(raw0);
    if (byExactKey !== undefined) return byExactKey;

    const norm = normalizeQuery(raw0);
    const aliased = aliasTo.get(norm);
    if (aliased !== undefined) return byId.get(aliased);
    return byId.get(norm);
  };

  return { entries, nonScalarKeys, resolve };
}

/** Throw the standard error for an id nothing answers to. */
export function unknownCapability(name: string, known: readonly string[]): never {
  const suggestion = known
    .filter((k) => k.includes(normalizeQuery(name)) || normalizeQuery(name).includes(k))
    .slice(0, 5);
  throw new CapsError(
    `Unknown capability '${name}'. This package has ${known.length} addressable ` +
      `capability ids on this machine; call all() to list them.` +
      (suggestion.length > 0 ? ` Did you mean: ${suggestion.join(', ')}?` : ''),
    CapsErrorCode.UNKNOWN_CAPABILITY,
    { requested: name, normalized: normalizeQuery(name), suggestions: suggestion },
  );
}

/** `has()` semantics, in one place so the collapse is auditable. */
export function collapse(state: CapabilityState): boolean {
  return state === 'detected';
}
