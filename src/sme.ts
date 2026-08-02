/**
 * SME, with the kernel's two naming schemes hidden from the caller.
 *
 * The kernel publishes SME datatype support under two spellings:
 *
 *   hw.optional.arm.SME_I8I32          short form
 *   hw.optional.arm.FEAT_SME_I16I64    prefixed form
 *
 * Which datatype lives in which scheme is a kernel implementation detail with
 * no meaning to a caller. `caps.sme.supports('I8I32')` and
 * `caps.sme.supports('I16I64')` therefore both work, and so do `SME_I8I32`,
 * `FEAT_SME_I16I64`, `sme_i8i32` and the full sysctl key. The unification is
 * not a mapping table: both spellings normalise onto the same `sme_<datatype>`
 * capability id (see `idFromLeaf`), so a future kernel that moves a datatype
 * between schemes needs no change here.
 */
import type { Catalogue } from './registry.js';
import { unknownCapability } from './registry.js';
import type { NativePayload } from './native.js';
import type { CapabilityState, NumericReading } from './state.js';
import { parseExact } from './state.js';

/** Which spelling answered. Informational; callers should not need it. */
export type SmeNamingScheme = 'short' | 'prefixed';

export interface SmeDatatype {
  /** Canonical capability id, e.g. `sme_i8i32`. */
  readonly id: string;
  /** The datatype on its own, e.g. `I8I32`. What `supports()` takes. */
  readonly label: string;
  readonly sysctlKey: string | null;
  readonly scheme: SmeNamingScheme | null;
  readonly state: CapabilityState;
  /** Why anyone would care about this particular datatype. */
  readonly note: string | null;
}

export interface SmeInfo {
  /** `hw.optional.arm.FEAT_SME` was detected. */
  readonly available: boolean;
  readonly sme2: boolean;
  readonly sme2p1: boolean;
  /** Streaming vector length in bits. 512 on M4. `null` when not established. */
  readonly svlBits: number | null;
  /** The same length in bytes, as the kernel publishes it. */
  readonly svlBytes: number | null;
  /** The full datatype matrix, as structured data. */
  readonly datatypes: readonly SmeDatatype[];
  /** The SVL answer with its evidence. */
  readonly svl: NumericReading;
  readonly note: string;
  /**
   * True only when the datatype was positively established. Accepts either
   * kernel naming scheme, in any case, with or without prefixes.
   * Throws UNKNOWN_CAPABILITY for a datatype this package has never heard of.
   */
  supports(datatype: string): boolean;
  /** The full record for a datatype, including which key answered. */
  detail(datatype: string): SmeDatatype;
}

/**
 * Datatype labels this package documents, so `supports()` answers rather than
 * throwing on a machine where the key is missing. The list is a union with
 * whatever the kernel walk actually discovered, so a new datatype appearing in
 * a future macOS shows up without a code change here.
 */
const DOCUMENTED_DATATYPES: readonly string[] = [
  'i8i32',
  'i16i32',
  'i16i64',
  'f16f32',
  'f32f32',
  'f64f64',
  'f16f16',
  'b16f32',
  'b16b16',
  'bi32i32',
];

const DATATYPE_NOTES: Readonly<Record<string, string>> = {
  i8i32:
    'Signed 8-bit multiply accumulating into 32-bit. This is the shape a ' +
    'GF(2^8) Reed-Solomon matrix kernel needs: byte-wide symbols, wide ' +
    'accumulator, outer-product form.',
  i16i64:
    'Signed 16-bit multiply accumulating into 64-bit. Suits a matrix NTT, ' +
    'where coefficients are narrow but products must not wrap before reduction.',
};

const DATATYPE_ID = /^sme_([a-z]{1,2}\d{1,2}[a-z]{1,2}\d{1,2})$/;

/** Reduce any spelling a caller might use to a bare datatype label. */
export function normalizeDatatype(input: string): string {
  let s = input.trim().toLowerCase();
  if (s.startsWith('hw.optional.')) s = s.slice('hw.optional.'.length);
  if (s.startsWith('arm.')) s = s.slice(4);
  if (s.startsWith('feat_')) s = s.slice(5);
  if (s.startsWith('sme_')) s = s.slice(4);
  return s;
}

function schemeOf(key: string | null): SmeNamingScheme | null {
  if (key === null) return null;
  if (key.includes('.FEAT_SME_')) return 'prefixed';
  if (key.includes('.SME_')) return 'short';
  return null;
}

export function buildSme(raw: NativePayload, catalogue: Catalogue): SmeInfo {
  const labels = new Set<string>(DOCUMENTED_DATATYPES);
  for (const entry of catalogue.entries) {
    const m = DATATYPE_ID.exec(entry.id);
    if (m?.[1] !== undefined) labels.add(m[1]);
  }

  const datatypes: SmeDatatype[] = [...labels]
    .sort()
    .map((label) => {
      const found = catalogue.resolve(`sme_${label}`);
      return {
        id: `sme_${label}`,
        label: label.toUpperCase(),
        sysctlKey: found?.sysctlKey ?? null,
        scheme: schemeOf(found?.sysctlKey ?? null),
        state: found?.state ?? 'undetectable',
        note: DATATYPE_NOTES[label] ?? null,
      } satisfies SmeDatatype;
    });

  const byLabel = new Map(datatypes.map((d) => [d.label.toLowerCase(), d]));

  const svlRaw = raw.sme.maxStreamingVectorLength;
  const svlBytes = svlRaw.present ? parseExact(svlRaw.bytes) : null;
  const svlBits = svlRaw.present ? parseExact(svlRaw.bits) : null;
  const svl: NumericReading =
    svlBits !== null
      ? {
          state: 'measured',
          value: svlBits,
          evidence: {
            kind: 'sysctl',
            key: svlRaw.key,
            value: svlBytes,
            valueText: svlRaw.bytes,
            widthBytes: 4,
          },
        }
      : {
          state: 'undetectable',
          value: null,
          reason:
            `'${svlRaw.key}' did not appear in the ${raw.mibNamesDiscovered} names ` +
            `discovered under ${raw.enumerationRoot}, so the streaming vector ` +
            `length was not established.`,
          permanent: false,
        };

  const resolveLabel = (input: string): SmeDatatype => {
    const label = normalizeDatatype(input);
    const found = byLabel.get(label);
    if (found === undefined) {
      unknownCapability(
        input,
        datatypes.map((d) => d.label),
      );
    }
    return found;
  };

  return {
    available: catalogue.resolve('sme')?.state === 'detected',
    sme2: catalogue.resolve('sme2')?.state === 'detected',
    sme2p1: catalogue.resolve('sme2p1')?.state === 'detected',
    svlBits,
    svlBytes,
    datatypes,
    svl,
    note:
      'Apple SME is streaming-only: there is no plain SVE on Apple Silicon, and ' +
      'no hw.optional.arm.FEAT_SVE key exists. Datatype support is published ' +
      'under two kernel naming schemes (arm.SME_* and arm.FEAT_SME_*); both are ' +
      'accepted by supports() and normalise to the same id, so callers never ' +
      'have to know which one a datatype lives in. SME_I8I32 is the shape a ' +
      'GF(2^8) Reed-Solomon matrix kernel needs; SME_I16I64 suits a matrix NTT.',
    supports: (datatype: string): boolean => resolveLabel(datatype).state === 'detected',
    detail: resolveLabel,
  };
}
