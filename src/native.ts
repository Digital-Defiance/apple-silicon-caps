/**
 * The addon boundary.
 *
 * Two responsibilities and no more: describe the shape the native layer
 * returns, and load the addon. There is no interpretation in this file. The
 * native layer is deliberately dumber than the public API (see caps.mm), and
 * this file is the last place that is still allowed to be that dumb.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CapsError, CapsErrorCode } from './errors.js';

/**
 * The three-way outcome from a named probe.
 *
 * `-1` means NO VALUE WAS OBTAINED. It is deliberately NOT collapsed into
 * "feature absent" here; that collapse is the defect this package exists to
 * remove. The accompanying errno is what lets the layer above tell "the kernel
 * has never heard of this key" apart from "the kernel publishes this key and
 * is declining to answer for this architecture".
 */
export type RawOutcome = -1 | 0 | 1;

/** `[key, decimalValue | '' when non-scalar, widthBytes, hexOfEveryByte]` */
export type RawEnumeratedEntry = readonly [
  key: string,
  value: string,
  widthBytes: number,
  hex: string,
];

/** `[key, errno, strerror]` — name found in the MIB, no value returned. */
export type RawUnreadableEntry = readonly [key: string, errno: number, strerror: string];

/** `[key, outcome, decimalValue, widthBytes, errno, strerror]` */
export type RawNamedProbe = readonly [
  key: string,
  outcome: RawOutcome,
  value: string,
  widthBytes: number,
  errno: number,
  strerror: string,
];

/** `[leaf, outcome, decimalValue]` — answered by EXACT leaf name. */
export type RawLeafAnswer = readonly [leaf: string, outcome: RawOutcome, value: string];

/** `[fullKey, decimalValue | '']` */
export type RawKeyValuePair = readonly [key: string, value: string];

export interface RawArmCaps {
  readonly key: string;
  readonly present: boolean;
  readonly widthBytes: number;
  readonly hex: string;
  readonly leadingU64: string;
  readonly decoded: false;
  readonly note: string;
}

export interface RawSme {
  readonly familyFromEnumeration: readonly RawKeyValuePair[];
  readonly derivedFrom: string;
  readonly maxStreamingVectorLength: {
    readonly key: string;
    readonly present: boolean;
    readonly bytes: string;
    readonly bits: string;
  };
  readonly exact: readonly RawLeafAnswer[];
}

export interface RawSveTrap {
  readonly keysContainingSve: readonly RawKeyValuePair[];
  readonly bareSveKeyPresent: boolean;
  readonly sve2KeyPresent: boolean;
  readonly trap: string;
}

export interface RawAmx {
  readonly probed: false;
  readonly namesFoundInEnumeration: readonly string[];
  readonly note: string;
}

export interface RawGpuCoreCount {
  readonly ok: boolean;
  readonly value: number;
  readonly ioClass: string;
  readonly matchedClass: string;
  readonly property: string;
  readonly reason: string;
}

/** Exactly what `caps_detect()` returns. Primitives and arrays of primitives. */
export interface NativePayload {
  readonly nativeSchemaVersion: number;
  readonly buildArch: string;
  readonly isArm64Build: boolean;

  readonly enumerationRoot: string;
  readonly enumerationOk: boolean;
  readonly mibNamesDiscovered: number;
  readonly enumerated: readonly RawEnumeratedEntry[];
  readonly unreadableKeys: readonly RawUnreadableEntry[];
  readonly skippedKeys: readonly string[];

  readonly namedProbes: readonly RawNamedProbe[];

  readonly armCapsRaw: RawArmCaps;
  readonly sme: RawSme;
  readonly sveTrap: RawSveTrap;
  readonly amx: RawAmx;
  readonly phantomKeysNeverQueried: readonly string[];

  readonly metalAvailable: boolean;
  readonly metalDeviceName: string;
  readonly metalApi: string;

  readonly gpuCoreCount: RawGpuCoreCount;

  readonly cpuBrandString: string;
  readonly cpuBrandStringKey: string;
  readonly cpuBrandStringWarning: string;
}

export interface NativeAddon {
  caps_detect(): NativePayload;
  caps_probed_keys(): readonly string[];
}

const require = createRequire(import.meta.url);

/**
 * The package root, relative to this file.
 *
 * This module lives at `src/native.ts` in the repo and at `dist/native.js` in
 * the published package. Both are exactly one directory below the package
 * root, so a single `..` is correct in both. That is a coincidence worth
 * stating out loud rather than relying on silently.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

let addon: NativeAddon | undefined;

/**
 * Load the addon, or throw.
 *
 * A failed *probe* is data. A failed *load* is an error, and it is thrown
 * immediately with the paths it looked at. Degrading to an all-undetectable
 * snapshot would be the friendlier-looking behaviour and would hide exactly
 * the packaging bug class that shipped @digitaldefiance/node-rs-accelerate@0.1.2
 * in an unloadable state: every consumer would have quietly seen "no hardware
 * features" and shipped the slow path.
 */
export function loadNative(): NativeAddon {
  if (addon !== undefined) return addon;

  if (process.platform !== 'darwin') {
    throw new CapsError(
      `@digitaldefiance/apple-silicon-caps supports darwin only; this process ` +
        `reports platform '${process.platform}'. package.json declares ` +
        `os: ["darwin"], so reaching this line means the install was forced ` +
        `or node_modules was vendored from another platform.`,
      CapsErrorCode.UNSUPPORTED_PLATFORM,
      { platform: process.platform, arch: process.arch },
    );
  }

  const prebuildsDir = join(packageRoot, 'prebuilds');
  const buildDir = join(packageRoot, 'build', 'Release');

  try {
    const load = require('node-gyp-build') as (dir: string) => NativeAddon;
    addon = load(packageRoot);
  } catch (cause) {
    throw new CapsError(
      `The native addon could not be loaded. This is almost always a ` +
        `packaging bug rather than a property of this machine.\n` +
        `  package root      ${packageRoot}\n` +
        `  prebuilds/ exists ${existsSync(prebuildsDir)}\n` +
        `  build/Release/    ${existsSync(buildDir)}\n` +
        `  platform/arch     ${process.platform}/${process.arch}\n` +
        `  underlying error  ${cause instanceof Error ? cause.message : String(cause)}`,
      CapsErrorCode.NATIVE_LOAD_FAILED,
      {
        packageRoot,
        prebuildsPresent: existsSync(prebuildsDir),
        buildReleasePresent: existsSync(buildDir),
        cause,
      },
    );
  }

  if (
    typeof addon.caps_detect !== 'function' ||
    typeof addon.caps_probed_keys !== 'function'
  ) {
    const loaded = addon;
    addon = undefined;
    throw new CapsError(
      `The native addon loaded but does not export the expected functions. ` +
        `Found: ${Object.keys(loaded as object).join(', ') || '(nothing)'}. ` +
        `Expected caps_detect and caps_probed_keys.`,
      CapsErrorCode.NATIVE_LOAD_FAILED,
      { packageRoot, exports: Object.keys(loaded as object) },
    );
  }

  return addon;
}
