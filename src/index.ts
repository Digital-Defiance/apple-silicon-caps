/**
 * @digitaldefiance/apple-silicon-caps
 *
 * Honest hardware capability detection for Apple Silicon. Every answer carries
 * its evidence, and no answer is invented.
 *
 * The 90% path is one line:
 *
 * ```ts
 * import caps from '@digitaldefiance/apple-silicon-caps';
 *
 * caps.has('sme');            // true
 * caps.sme.svlBits;           // 512
 * caps.sme.supports('I8I32'); // true
 * caps.gpu.cores;             // 40
 * caps.cpu.performanceCores;  // 12
 * ```
 *
 * The rigour is underneath, reachable when it matters:
 *
 * ```ts
 * caps.detail('amx');   // { state: 'undetectable', permanent: true, reason: '...' }
 * caps.all();           // every capability, with state and evidence
 * caps.raw();           // the untouched native payload, for bug reports
 * ```
 *
 * ONE THING TO INTERNALISE: `has()` returns false for BOTH "the source said no"
 * and "nothing could be learned". Read it as NOT ESTABLISHED. `detail()` tells
 * you which, and there are exactly three capabilities on Apple Silicon where the
 * difference bites: amx, sve and sve2.
 *
 * THE OTHER THING: most ids are DISCOVERED from the running kernel, not declared
 * here, so most of them are not guaranteed to exist on another Mac. Only the
 * documented ids always resolve. For anything else, either handle the unknown
 * case or say what it means:
 *
 * ```ts
 * caps.lookup('cssc');                    // CapabilityDetail | undefined, never throws
 * caps.has('cssc', { ifUnknown: false }); // portable; the default is written down
 * caps.has('cssc');                       // throws where the kernel lacks the name
 * ```
 *
 * Detection runs when this module is first imported and the result is memoized
 * and frozen. A failed sysctl probe is data and lands in the snapshot; a failed
 * addon load throws immediately, because a detection library that silently
 * reports "no features" is worse than one that fails.
 */
export { CapsError, CapsErrorCode } from './errors.js';

export type {
  Capability,
  CapabilityState,
  Detected,
  EnumerationAbsenceEvidence,
  Evidence,
  IoRegistryEvidence,
  KernelDeclinedEvidence,
  MetalEvidence,
  NotPresent,
  NumericReading,
  ProbeInput,
  SysctlEvidence,
  Undetectable,
} from './state.js';
export { ENOENT, ENOTSUP, errnoName, isEnabled, mapProbe, parseExact } from './state.js';

export type {
  CapabilityDetail,
  CapabilityGroup,
  CapabilityId,
  CapabilityMeta,
  Catalogue,
  DocumentedCapability,
  IfUnknown,
} from './registry.js';
export { DOCUMENTED_LEAVES, buildCatalogue, idFromLeaf } from './registry.js';

export type { SmeDatatype, SmeInfo, SmeNamingScheme } from './sme.js';
export { normalizeDatatype } from './sme.js';

export type {
  CacheInfo,
  CacheReadings,
  CpuInfo,
  CpuReadings,
  GpuInfo,
  MemoryInfo,
  MemoryReadings,
} from './topology.js';

export type {
  NativeAddon,
  NativePayload,
  RawArmCaps,
  RawEnumeratedEntry,
  RawGpuCoreCount,
  RawNamedProbe,
  RawOutcome,
  RawSme,
  RawSveTrap,
  RawUnreadableEntry,
} from './native.js';

export type { CanonicalSnapshot, Caps, ConformanceViolation } from './snapshot.js';
export {
  canonicalSnapshot,
  checkConformance,
  detect,
  queriedSysctlKeys,
} from './snapshot.js';

export { formatReport } from './report.js';

import { detect } from './snapshot.js';

/**
 * The memoized, frozen snapshot of this machine.
 *
 * Identical to `detect()`, exported as the default so the common case is a
 * single import with no call. `caps === detect()` is guaranteed.
 */
const caps = detect();
export default caps;
