/**
 * The state model, and the one function that decides a state.
 *
 * Everything downstream of `mapProbe` is presentation. Everything upstream is
 * raw kernel output. This file is where the single correctness rule lives:
 * NEVER REPORT A CAPABILITY THAT WAS NOT ESTABLISHED.
 */

/**
 * How an answer was arrived at.
 *
 * - `detected`      positively established: a source was consulted and said yes
 * - `not-present`   a source was consulted and said no
 * - `undetectable`  nothing was learned; the reason says why
 *
 * There is no fourth state. An earlier draft had `inferred` for the GPU core
 * count; the core count is now read out of the IORegistry, so there is nothing
 * left to infer and the state was deleted rather than left lying around.
 */
export type CapabilityState = 'detected' | 'not-present' | 'undetectable';

/** A sysctl key was read and returned a value. */
export interface SysctlEvidence {
  readonly kind: 'sysctl';
  readonly key: string;
  /**
   * The value as a number, or `null` when the kernel returned something
   * outside the exactly-representable integer range. Values cross the FFI
   * boundary as decimal strings for this reason: `hw.optional.arm.caps` alone
   * exceeds Number.MAX_SAFE_INTEGER, and a detection library that rounds its
   * own output is not a detection library.
   */
  readonly value: number | null;
  /** The value exactly as the kernel reported it. Never rounded. */
  readonly valueText: string;
  readonly widthBytes: number;
}

/**
 * The key IS published in this kernel's MIB and the kernel refused to produce
 * a value for it on this architecture (ENOTSUP). That is an answer, not a gap.
 */
export interface KernelDeclinedEvidence {
  readonly kind: 'kernel-declined';
  readonly key: string;
  readonly errno: number;
  readonly errnoName: string;
  readonly strerror: string;
  readonly note: string;
}

/** Metal was asked, through the real API. */
export interface MetalEvidence {
  readonly kind: 'metal';
  readonly api: string;
  readonly deviceName: string | null;
}

/** A property was read out of the IORegistry. A measurement. */
export interface IoRegistryEvidence {
  readonly kind: 'ioregistry';
  readonly ioClass: string;
  readonly matchedClass: string | null;
  readonly property: string;
}

/**
 * A name was NOT produced by a complete walk of an enumerable MIB subtree.
 *
 * This is stronger than a failed query for the same name: a failed query is
 * indistinguishable from a dozen errno values, whereas a complete walk that
 * never produced the name proves the name is not there. It proves something
 * about the KEY, though, not about the silicon, which is why the capabilities
 * that rest on it are `undetectable` and not `not-present`.
 */
export interface EnumerationAbsenceEvidence {
  readonly kind: 'enumeration-absence';
  readonly root: string;
  readonly key: string;
  readonly namesDiscovered: number;
  readonly note: string;
}

export type Evidence =
  | SysctlEvidence
  | KernelDeclinedEvidence
  | MetalEvidence
  | IoRegistryEvidence
  | EnumerationAbsenceEvidence;

export interface Detected {
  readonly state: 'detected';
  readonly evidence: Evidence;
}

export interface NotPresent {
  readonly state: 'not-present';
  readonly evidence: Evidence;
}

export interface Undetectable {
  readonly state: 'undetectable';
  /** Why nothing was learned. Always specific enough to act on. */
  readonly reason: string;
  /** True when no future macOS release could change this answer. */
  readonly permanent: boolean;
}

export type Capability = Detected | NotPresent | Undetectable;

/** A number that was read, or an explanation of why it was not. */
export type NumericReading =
  | { readonly state: 'measured'; readonly value: number; readonly evidence: Evidence }
  | {
      readonly state: 'undetectable';
      readonly value: null;
      readonly reason: string;
      readonly permanent: boolean;
    };

// ---------------------------------------------------------------------------
// errno
// ---------------------------------------------------------------------------

/** The kernel has never heard of this name. */
export const ENOENT = 2;
/** The name is published and the kernel declines to answer for this arch. */
export const ENOTSUP = 45;

const ERRNO_NAMES: Readonly<Record<number, string>> = {
  1: 'EPERM',
  2: 'ENOENT',
  12: 'ENOMEM',
  13: 'EACCES',
  21: 'EISDIR',
  22: 'EINVAL',
  45: 'ENOTSUP',
  84: 'EOVERFLOW',
};

export function errnoName(errno: number): string {
  return ERRNO_NAMES[errno] ?? `errno ${errno}`;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Decimal string -> number, or null when the value is not exactly
 * representable. Deliberately refuses rather than rounding.
 */
export function parseExact(decimal: string): number | null {
  if (decimal === '') return null;
  const n = Number(decimal);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// The mapping. Four input cases, three output states.
// ---------------------------------------------------------------------------

export interface ProbeInput {
  readonly key: string;
  readonly outcome: -1 | 0 | 1;
  /** Decimal string exactly as the kernel produced it. `''` when non-scalar. */
  readonly value: string;
  readonly widthBytes: number;
  readonly errno: number;
  readonly strerror: string;
}

/**
 * Decide a state from a raw probe outcome.
 *
 *   outcome  1                     -> detected      (key read, value non-zero)
 *   outcome  0                     -> not-present   (key read, value zero)
 *   outcome -1, errno ENOTSUP (45) -> not-present   (kernel declined for this arch)
 *   outcome -1, errno ENOENT  (2)  -> undetectable  (key not in this MIB)
 *   outcome -1, any other errno    -> undetectable  (reason names the errno)
 *
 * WHY ENOTSUP IS `not-present` AND ENOENT IS `undetectable`
 *
 * ENOTSUP is the kernel ANSWERING. It publishes the name in the MIB and tells
 * you the node does not apply on this architecture. ENOENT is the kernel never
 * having heard of the name, which tells you nothing about the feature at all.
 * Treating a real answer as ignorance is its own small lie, in the opposite
 * direction from the one this package was written to fix.
 *
 * This is not a theory. It is measured: on this arm64 kernel, 29 x86-only nodes
 * such as `hw.optional.avx512f` are discovered by name and fail with ENOTSUP,
 * while `hw.optional.arm.FEAT_SVE` fails with ENOENT because no such name
 * exists. Both produce no value; only errno separates them.
 */
export function mapProbe(p: ProbeInput): Capability {
  if (p.outcome === 1 || p.outcome === 0) {
    const evidence: SysctlEvidence = {
      kind: 'sysctl',
      key: p.key,
      value: parseExact(p.value),
      valueText: p.value,
      widthBytes: p.widthBytes,
    };
    return p.outcome === 1
      ? { state: 'detected', evidence }
      : { state: 'not-present', evidence };
  }

  if (p.errno === ENOTSUP) {
    return {
      state: 'not-present',
      evidence: {
        kind: 'kernel-declined',
        key: p.key,
        errno: p.errno,
        errnoName: errnoName(p.errno),
        strerror: p.strerror || 'Operation not supported',
        note:
          `The key is published in this kernel's MIB and the kernel declined ` +
          `to produce a value for it on this architecture. That is an answer: ` +
          `the feature does not apply here. It is a different fact from ENOENT, ` +
          `where the name is unknown and nothing is learned.`,
      },
    };
  }

  if (p.errno === ENOENT) {
    return {
      state: 'undetectable',
      reason:
        `sysctl key '${p.key}' is not in this kernel's MIB, so no value was ` +
        `obtained and nothing was learned. THIS IS NOT EVIDENCE OF ABSENCE. ` +
        `A future macOS release could publish the key.`,
      permanent: false,
    };
  }

  return {
    state: 'undetectable',
    reason:
      `Reading sysctl key '${p.key}' failed with ${errnoName(p.errno)} (${p.errno})` +
      `${p.strerror ? `: ${p.strerror}` : ''}. No value was obtained, so nothing ` +
      `was learned. THIS IS NOT EVIDENCE OF ABSENCE.`,
    permanent: false,
  };
}

/**
 * Collapse a capability to a boolean, forcing the caller to say what
 * `undetectable` means for them.
 *
 * This is no longer the primary path — `caps.has(id)` is — but it is kept
 * exported for callers who want the decision written down at the call site
 * instead of taken from a default.
 */
export function isEnabled(cap: Capability, whenUndetectable: boolean): boolean {
  if (cap.state === 'detected') return true;
  if (cap.state === 'not-present') return false;
  return whenUndetectable;
}
