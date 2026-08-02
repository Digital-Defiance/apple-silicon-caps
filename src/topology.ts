/**
 * Numbers: core counts, cache sizes, memory size, GPU core count.
 *
 * Every group exposes the plain number people came for AND a `readings` bag
 * holding the same answer with its evidence. The plain number is `number | null`
 * and `null` means "not established" for exactly the same reason `has()`
 * returning false does.
 */
import { CapsError, CapsErrorCode } from './errors.js';
import type { NativePayload } from './native.js';
import { type NumericReading, mapProbe } from './state.js';

export interface CpuReadings {
  readonly performanceCores: NumericReading;
  readonly efficiencyCores: NumericReading;
  readonly physicalCores: NumericReading;
  readonly logicalCores: NumericReading;
}

export interface CpuInfo {
  /** `hw.perflevel0.physicalcpu` */
  readonly performanceCores: number | null;
  /** `hw.perflevel1.physicalcpu` */
  readonly efficiencyCores: number | null;
  readonly physicalCores: number | null;
  readonly logicalCores: number | null;
  /** The architecture this addon was BUILT for. Not a runtime guess. */
  readonly buildArch: string;
  readonly readings: CpuReadings;
}

export interface MemoryReadings {
  readonly bytes: NumericReading;
  readonly pageSize: NumericReading;
}

export interface MemoryInfo {
  /** `hw.memsize`. Unified memory on Apple Silicon. */
  readonly bytes: number | null;
  readonly pageSize: number | null;
  readonly readings: MemoryReadings;
}

export interface CacheReadings {
  readonly l1d: NumericReading;
  readonly l1i: NumericReading;
  readonly l2: NumericReading;
  readonly lineSize: NumericReading;
}

export interface CacheInfo {
  /** `hw.l1dcachesize`, bytes. */
  readonly l1d: number | null;
  /** `hw.l1icachesize`, bytes. */
  readonly l1i: number | null;
  /** `hw.l2cachesize`, bytes. */
  readonly l2: number | null;
  /** `hw.cachelinesize`, bytes. */
  readonly lineSize: number | null;
  readonly readings: CacheReadings;
}

export interface GpuInfo {
  /**
   * Measured from the IORegistry (`AGXAccelerator` -> `gpu-core-count`), not
   * looked up from a chip-name table. `null` when the property could not be
   * read; there is no fallback literal, because the fallback literal is how
   * node-fhe-accelerate came to report 40 cores on every Mac.
   */
  readonly cores: number | null;
  /** Metal answered through `MTLCreateSystemDefaultDevice`. */
  readonly metal: boolean;
  readonly deviceName: string | null;
  readonly readings: { readonly cores: NumericReading };
}

/**
 * Keys this layer reads out of the native named-probe results.
 *
 * If the native layer stops probing one of these, that is a defect in THIS
 * package rather than a property of the machine, and it throws MANIFEST_DESYNC
 * instead of quietly reporting null. Note that a key which exists in the
 * manifest but is absent from this kernel's MIB does NOT land here: the native
 * layer still returns an entry for it, with outcome -1, and it becomes an
 * honest `undetectable` reading.
 */
const TOPOLOGY_KEYS = {
  memsize: 'hw.memsize',
  physicalcpu: 'hw.physicalcpu',
  logicalcpu: 'hw.logicalcpu',
  perflevel0: 'hw.perflevel0.physicalcpu',
  perflevel1: 'hw.perflevel1.physicalcpu',
  l1d: 'hw.l1dcachesize',
  l1i: 'hw.l1icachesize',
  l2: 'hw.l2cachesize',
  lineSize: 'hw.cachelinesize',
  pagesize: 'hw.pagesize',
} as const;

function readingFor(raw: NativePayload, key: string): NumericReading {
  const probe = raw.namedProbes.find(([k]) => k === key);
  if (probe === undefined) {
    throw new CapsError(
      `Internal: the native layer did not probe '${key}', which the TypeScript ` +
        `assembly table requires. The native manifest and this table are out of ` +
        `sync, which is a defect in this package, not a property of this machine.`,
      CapsErrorCode.MANIFEST_DESYNC,
      { key, probedKeys: raw.namedProbes.map(([k]) => k) },
    );
  }
  const [, outcome, value, widthBytes, errno, strerror] = probe;
  const cap = mapProbe({ key, outcome, value, widthBytes, errno, strerror });

  if (cap.state === 'undetectable') {
    return { state: 'undetectable', value: null, reason: cap.reason, permanent: cap.permanent };
  }
  if (cap.evidence.kind !== 'sysctl' || cap.evidence.value === null) {
    // The key answered but the number is not exactly representable, or the
    // answer was a kernel decline. Either way there is no integer to hand out
    // and inventing one is the defect.
    return {
      state: 'undetectable',
      value: null,
      reason:
        `'${key}' produced no exactly-representable integer ` +
        `(${cap.evidence.kind === 'sysctl' ? `raw value '${cap.evidence.valueText}'` : cap.evidence.kind}). ` +
        `Reported as unknown rather than rounded.`,
      permanent: false,
    };
  }
  return { state: 'measured', value: cap.evidence.value, evidence: cap.evidence };
}

export function buildCpu(raw: NativePayload): CpuInfo {
  const readings: CpuReadings = {
    performanceCores: readingFor(raw, TOPOLOGY_KEYS.perflevel0),
    efficiencyCores: readingFor(raw, TOPOLOGY_KEYS.perflevel1),
    physicalCores: readingFor(raw, TOPOLOGY_KEYS.physicalcpu),
    logicalCores: readingFor(raw, TOPOLOGY_KEYS.logicalcpu),
  };
  return {
    performanceCores: readings.performanceCores.value,
    efficiencyCores: readings.efficiencyCores.value,
    physicalCores: readings.physicalCores.value,
    logicalCores: readings.logicalCores.value,
    buildArch: raw.buildArch,
    readings,
  };
}

export function buildMemory(raw: NativePayload): MemoryInfo {
  const readings: MemoryReadings = {
    bytes: readingFor(raw, TOPOLOGY_KEYS.memsize),
    pageSize: readingFor(raw, TOPOLOGY_KEYS.pagesize),
  };
  return { bytes: readings.bytes.value, pageSize: readings.pageSize.value, readings };
}

export function buildCache(raw: NativePayload): CacheInfo {
  const readings: CacheReadings = {
    l1d: readingFor(raw, TOPOLOGY_KEYS.l1d),
    l1i: readingFor(raw, TOPOLOGY_KEYS.l1i),
    l2: readingFor(raw, TOPOLOGY_KEYS.l2),
    lineSize: readingFor(raw, TOPOLOGY_KEYS.lineSize),
  };
  return {
    l1d: readings.l1d.value,
    l1i: readings.l1i.value,
    l2: readings.l2.value,
    lineSize: readings.lineSize.value,
    readings,
  };
}

export function buildGpu(raw: NativePayload): GpuInfo {
  const g = raw.gpuCoreCount;
  const cores: NumericReading = g.ok
    ? {
        state: 'measured',
        value: g.value,
        evidence: {
          kind: 'ioregistry',
          ioClass: g.ioClass,
          matchedClass: g.matchedClass === '' ? null : g.matchedClass,
          property: g.property,
        },
      }
    : {
        state: 'undetectable',
        value: null,
        reason: g.reason || `The IORegistry property '${g.property}' could not be read.`,
        permanent: false,
      };

  return {
    cores: cores.value,
    metal: raw.metalAvailable,
    deviceName: raw.metalDeviceName === '' ? null : raw.metalDeviceName,
    readings: { cores },
  };
}
