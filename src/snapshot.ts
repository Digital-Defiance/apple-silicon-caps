/**
 * The snapshot: one detection, memoized, deep-frozen, with the ergonomic
 * accessors on top of it.
 *
 * The shape of this file follows one rule about people rather than about
 * kernels: the 90% question is "can I use this instruction", and asking it must
 * cost one line. The epistemology stays reachable through `detail()` and
 * `all()`; it is not a toll gate on the front door.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { CapsError, CapsErrorCode } from './errors.js';
import { type NativePayload, loadNative } from './native.js';
import {
  type Catalogue,
  type CapabilityDetail,
  type CapabilityId,
  type IfUnknown,
  buildCatalogue,
  collapse,
  unknownCapability,
} from './registry.js';
import { type SmeInfo, buildSme } from './sme.js';
import type { CapabilityState } from './state.js';
import {
  type CacheInfo,
  type CpuInfo,
  type GpuInfo,
  type MemoryInfo,
  buildCache,
  buildCpu,
  buildGpu,
  buildMemory,
} from './topology.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

/** The public snapshot. Frozen; the same object every time. */
export interface Caps {
  readonly schemaVersion: 1;
  readonly packageVersion: string;

  /**
   * The CPU brand string, e.g. `'Apple M4 Max'`.
   *
   * INFORMATIONAL ONLY. This is here so a bug report can say which machine
   * produced a given output, and for no other purpose. It is NOT evidence for
   * anything: no capability in this package is derived from it, and deriving
   * one from it is the specific defect this package exists to remove. Four of
   * the eight audited detectors decided a feature was present because
   * `strstr(brand, "Apple")` or `strstr(brand, "M4")` succeeded, which
   * establishes only that the machine is a Mac.
   */
  readonly chip: string | null;
  /** Spelled out next to the value so it travels with it. */
  readonly chipWarning: string;

  readonly cpu: CpuInfo;
  readonly gpu: GpuInfo;
  readonly memory: MemoryInfo;
  readonly cache: CacheInfo;
  readonly sme: SmeInfo;

  /**
   * "Was this capability established?"
   *
   * Returns `true` only for `detected`. It returns `false` for BOTH
   * `not-present` and `undetectable`, so read it as NOT ESTABLISHED rather than
   * as ABSENT. `caps.has('amx')` is `false` because nothing can be learned about
   * AMX, not because the hardware lacks it; `caps.detail('amx')` says so.
   *
   * That collapse is a deliberate ergonomic trade: the distinction stays
   * reachable, it just is not mandatory. Use `detail()` when it matters, or
   * `isEnabled(detail(id), true)` to declare the opposite default at the call
   * site.
   *
   * WHICH FORM TO CALL:
   *
   * - `has(id)` for an id you KNOW exists — the ~13 documented ones, or a
   *   discovered one you have verified on the machines you support. An id that
   *   resolves to nothing throws UNKNOWN_CAPABILITY, so a typo is a loud bug
   *   instead of a silent `false`.
   * - `has(id, { ifUnknown })` for the discovered long tail and for
   *   cross-version portability. Most ids on this machine came out of THIS
   *   kernel's MIB and may not exist on another: `has('cssc')` answers here,
   *   because the kernel publishes FEAT_CSSC, and would throw on a machine whose
   *   kernel does not. `has('cssc', { ifUnknown: false })` is the portable
   *   spelling, and it records the choice where the reader can see it.
   *
   * Both forms are honest; they differ only in what an UNKNOWN ID means, which
   * is a question about the caller's code, not about the silicon.
   */
  has(cap: CapabilityId, opts?: IfUnknown): boolean;

  /**
   * The full three-state record: state, evidence or reason, and which key
   * answered. Throws UNKNOWN_CAPABILITY for an id nothing answers to.
   *
   * There is deliberately no `detail(id, { ifUnknown })`. `has()` returns a
   * boolean, so a caller can supply the boolean they want for an unknown id and
   * nothing is fabricated. `detail()` returns a record carrying EVIDENCE, and
   * the only way to hand one back for an id that does not exist is to invent a
   * capability with invented evidence — a phantom, of exactly the kind this
   * package exists to refuse. `lookup()` is the non-throwing form instead: it
   * returns `undefined`, which is the truth.
   */
  detail(cap: CapabilityId): CapabilityDetail;

  /**
   * `detail()` without the throw: the full record, or `undefined` when nothing
   * answers to the id. NEVER THROWS, for any input.
   *
   * This is the primitive for asking about the discovered long tail, and for any
   * code that must run unchanged across macOS versions and Apple parts:
   *
   * ```ts
   * const cssc = caps.lookup('cssc');
   * if (cssc === undefined) {
   *   // this kernel does not publish the name; nothing was learned
   * } else if (cssc.state === 'detected') {
   *   // use it
   * }
   * ```
   *
   * `undefined` here is a fourth thing, and it is not a fourth capability state:
   * the three states describe what was learned about a capability, and
   * `undefined` says this package was never asked about a capability at all.
   */
  lookup(cap: CapabilityId): CapabilityDetail | undefined;

  /** Every capability, with state and evidence. Registration order. */
  all(): readonly CapabilityDetail[];

  /** Every addressable id, sorted. */
  ids(): readonly string[];

  /** The untouched native payload, frozen. Paste this into a bug report. */
  raw(): NativePayload;

  /**
   * Opt-in enforcement. The APPLICATION decides what it requires; this package
   * does not ship a required-capability list and does not throw on load.
   *
   * Throws UNKNOWN_CAPABILITY for an unknown id and UNSUPPORTED_PLATFORM when a
   * known id is not `detected`, with each shortfall's state and reason attached.
   */
  assertRequired(required: readonly CapabilityId[]): void;
}

export interface CanonicalSnapshot {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  /**
   * Sorted `name=state` pairs. STATES, never values: two machines of the same
   * model must agree, and the same machine read by four sibling packages must
   * agree exactly.
   */
  readonly entries: readonly string[];
  /** SHA-256 over `entries.join('\n')`. One value siblings can compare. */
  readonly digest: string;
}

export interface ConformanceViolation {
  readonly capability: string;
  readonly canonical: CapabilityState | 'unknown';
  readonly reported: CapabilityState | boolean;
  readonly explanation: string;
}

/**
 * Freeze an object graph. Detection is a snapshot of a machine that is not
 * going to change under us, and a frozen snapshot cannot be edited by one
 * consumer in a way another consumer observes.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined) continue;
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

let cached: Caps | undefined;
let cachedCatalogue: Catalogue | undefined;

/**
 * Detect once, then hand back the same frozen object.
 *
 * A failed sysctl probe is DATA and ends up in the snapshot as `undetectable`.
 * A failed addon load is an ERROR and is thrown from here, because degrading
 * silently to an all-undetectable snapshot would hide exactly the packaging bug
 * class that shipped node-rs-accelerate@0.1.2 unloadable.
 */
export function detect(): Caps {
  if (cached !== undefined) return cached;

  const addon = loadNative();
  const raw = addon.caps_detect();
  const catalogue = buildCatalogue(raw);
  cachedCatalogue = catalogue;

  const resolveOrThrow = (name: CapabilityId): CapabilityDetail => {
    const found = catalogue.resolve(name);
    if (found === undefined) {
      unknownCapability(
        name,
        catalogue.entries.map((e) => e.id),
      );
    }
    return found;
  };

  const frozenRaw = deepFreeze(raw);
  const entries = deepFreeze([...catalogue.entries]);
  const sortedIds = deepFreeze([...catalogue.entries.map((e) => e.id)].sort());

  const snapshot: Caps = {
    schemaVersion: 1,
    packageVersion: PACKAGE_VERSION,
    chip: raw.cpuBrandString === '' ? null : raw.cpuBrandString,
    chipWarning:
      `Informational only, read from ${raw.cpuBrandStringKey}. No capability in ` +
      `this package is derived from it and none may be. Brand-string inference ` +
      `is the defect this package exists to remove.`,
    cpu: buildCpu(raw),
    gpu: buildGpu(raw),
    memory: buildMemory(raw),
    cache: buildCache(raw),
    sme: buildSme(raw, catalogue),
    has: (cap, opts) => {
      const found = catalogue.resolve(cap);
      if (found !== undefined) return collapse(found.state);
      // No entry. With no second argument this is a caller bug and throws; with
      // one, the caller has already said what an unknown id means for them.
      if (opts !== undefined) return opts.ifUnknown;
      unknownCapability(
        cap,
        catalogue.entries.map((e) => e.id),
      );
    },
    detail: resolveOrThrow,
    lookup: (cap) => catalogue.resolve(cap),
    all: () => entries,
    ids: () => sortedIds,
    raw: () => frozenRaw,
    assertRequired: (required) => {
      const missing = required
        .map((name) => resolveOrThrow(name))
        .filter((entry) => entry.state !== 'detected');
      if (missing.length === 0) return;
      const lines = missing.map((m) =>
        m.state === 'undetectable'
          ? `  ${m.id}: undetectable${m.permanent ? ' (permanently)' : ''} - ${m.reason}`
          : `  ${m.id}: not-present - the source was consulted and reported absence`,
      );
      throw new CapsError(
        `Required capabilities were not established on this machine:\n${lines.join('\n')}`,
        CapsErrorCode.UNSUPPORTED_PLATFORM,
        {
          missing: missing.map((m) => ({ id: m.id, state: m.state })),
          required: [...required],
        },
      );
    },
  };

  cached = deepFreeze(snapshot);
  return cached;
}

/** Every sysctl key this package queries BY NAME, straight from the addon. */
export function queriedSysctlKeys(): readonly string[] {
  return loadNative().caps_probed_keys();
}

/**
 * A stable, order-independent digest of what this machine reports.
 *
 * Sibling packages assert against this so all of them report the SAME answer
 * for the SAME capability on the SAME machine.
 */
export function canonicalSnapshot(): CanonicalSnapshot {
  const caps = detect();
  const entries: string[] = [];

  for (const entry of caps.all()) entries.push(`cap.${entry.id}=${entry.state}`);

  entries.push(`cpu.performanceCores=${caps.cpu.readings.performanceCores.state}`);
  entries.push(`cpu.efficiencyCores=${caps.cpu.readings.efficiencyCores.state}`);
  entries.push(`cpu.physicalCores=${caps.cpu.readings.physicalCores.state}`);
  entries.push(`cpu.logicalCores=${caps.cpu.readings.logicalCores.state}`);
  entries.push(`memory.bytes=${caps.memory.readings.bytes.state}`);
  entries.push(`memory.pageSize=${caps.memory.readings.pageSize.state}`);
  entries.push(`cache.l1d=${caps.cache.readings.l1d.state}`);
  entries.push(`cache.l1i=${caps.cache.readings.l1i.state}`);
  entries.push(`cache.l2=${caps.cache.readings.l2.state}`);
  entries.push(`cache.lineSize=${caps.cache.readings.lineSize.state}`);
  entries.push(`gpu.cores=${caps.gpu.readings.cores.state}`);
  entries.push(`sme.svl=${caps.sme.svl.state}`);
  for (const dt of caps.sme.datatypes) entries.push(`sme.datatype.${dt.label}=${dt.state}`);

  entries.sort();

  return deepFreeze({
    schemaVersion: 1,
    packageVersion: caps.packageVersion,
    entries,
    digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
  });
}

/**
 * Compare a consumer's own capability report against this package's answers.
 *
 * Intended to be called from a sibling package's test suite, so "all four
 * report the same thing" is a mechanical assertion rather than an aspiration.
 * A consumer that maps `undetectable` onto a boolean must say which boolean via
 * `opts.undetectableMapsTo`; there is no default, because an implicit default is
 * how this started.
 */
export function checkConformance(
  consumerReport: Record<string, CapabilityState | boolean>,
  opts?: { undetectableMapsTo?: boolean },
): ConformanceViolation[] {
  const caps = detect();
  const violations: ConformanceViolation[] = [];

  for (const [name, reported] of Object.entries(consumerReport)) {
    let canonical: CapabilityDetail | undefined;
    try {
      canonical = caps.detail(name);
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined) {
      violations.push({
        capability: name,
        canonical: 'unknown',
        reported,
        explanation:
          `This package has no capability id '${name}', so the consumer is ` +
          `reporting on something it cannot have detected through this package.`,
      });
      continue;
    }

    if (typeof reported === 'boolean') {
      if (canonical.state === 'undetectable' && opts?.undetectableMapsTo === undefined) {
        violations.push({
          capability: name,
          canonical: canonical.state,
          reported,
          explanation:
            `'${name}' is undetectable, and the consumer reported a boolean ` +
            `without declaring what undetectable maps to. Pass ` +
            `opts.undetectableMapsTo to record the mapping explicitly.`,
        });
        continue;
      }
      const expected =
        canonical.state === 'detected'
          ? true
          : canonical.state === 'not-present'
            ? false
            : (opts?.undetectableMapsTo ?? false);
      if (reported !== expected) {
        violations.push({
          capability: name,
          canonical: canonical.state,
          reported,
          explanation:
            `'${name}' is ${canonical.state} here, which collapses to ` +
            `${String(expected)} under the declared mapping, but the consumer ` +
            `reported ${String(reported)}.`,
        });
      }
      continue;
    }

    if (reported !== canonical.state) {
      violations.push({
        capability: name,
        canonical: canonical.state,
        reported,
        explanation:
          `'${name}' is ${canonical.state} here but the consumer reported ` +
          `${reported}. One of the two is wrong about the same machine.`,
      });
    }
  }

  return violations;
}

/** Internal: the catalogue behind the memoized snapshot. Used by the report. */
export function catalogueOf(): Catalogue {
  detect();
  if (cachedCatalogue === undefined) {
    throw new CapsError(
      'Internal: the catalogue was not built alongside the snapshot.',
      CapsErrorCode.MANIFEST_DESYNC,
    );
  }
  return cachedCatalogue;
}
