# @digitaldefiance/apple-silicon-caps

Hardware capability detection for Apple Silicon that reports three states instead of two: `detected`, `not-present`, `undetectable`. Every answer carries the evidence that produced it — the sysctl key and its value, the errno the kernel returned, the IORegistry property that was read. The reason for the third state is that a boolean cannot express "nothing was learned", and on Apple Silicon there are capabilities about which nothing can be learned from user space. A detector with only two states has to guess in those cases, and a guess that is shaped like a measurement is worse than no answer at all.

Supported on macOS, arm64 and x64. An x64 build loads and honestly reports that there is no Apple Silicon here.

## Install

```sh
npm install @digitaldefiance/apple-silicon-caps
```

```ts
import caps from '@digitaldefiance/apple-silicon-caps';

caps.has('sme');            // true   - established from hw.optional.arm.FEAT_SME
caps.sme.svlBits;           // 512    - streaming vector length, read not inferred
caps.sme.supports('I8I32'); // true   - the datatype an int8 matrix kernel needs
caps.gpu.cores;             // 40     - IORegistry AGXAccelerator gpu-core-count
caps.detail('amx');         // { state: 'undetectable', permanent: true, reason: ... }
```

```sh
npx @digitaldefiance/apple-silicon-caps
```

## AMX is not detectable from user space

This package will never report AMX as present and will never report it as absent. Not as a policy preference — because there is nothing to report:

- No key for it appears anywhere under `hw.optional`. On an M4 Max the MIB walk discovers 115 names, of which 86 return a value and 29 return `ENOTSUP`. None of the 115 contains the substring `amx`, so it is in none of the 86 readable keys.
- There is no public API. AMX is not user-space programmable. Code reaches it, if at all, as an internal implementation detail of the Accelerate framework, which this package cannot observe.
- Apple has published no specification for it.
- `hw.optional.amx_version` does not exist, despite appearing in shipped code that queries it.

`caps.detail('amx')` returns `undetectable` with `permanent: true`, and the native layer does not merely decline to answer — it never reads the value. The MIB walk collects names before reading any of them and drops any name containing `amx` before the read, so no AMX value can exist in the process. `caps.has('amx')` is `false`, because `has()` means "was this established", and it was not.

## Case study: eight detectors, four answers, one machine

Before this package existed, four libraries in the same codebase contained eight separate capability detectors. Asked about the same capability on the same machine, they produced four different answers:

- Four inferred it from `machdep.cpu.brand_string`. A substring match against `"Apple"` or `"M4"` establishes that the machine is a Mac and nothing else.
- Two queried a sysctl key that does not exist, and read the failed query as "feature absent". A nonexistent key and a genuinely absent feature both produce a failure with no value; nothing in the return distinguishes them.
- Two hardcoded a constant and reported it as a detection result.

None of these were careless. Each was a reasonable local decision forced by a type. The detector's return type was `boolean`, a boolean has two inhabitants, and the problem has three states. Whenever the honest answer was "unknown", the signature had no way to say it, so every implementation picked a lie and picked a different one. The fix is not more careful detectors. It is a third state, so the honest answer is expressible and the caller decides what to do with it.

This package's own guard against relapse: `checkConformance()` lets a consumer's capability report be compared against these answers mechanically, and it flags a consumer that collapses `undetectable` to a boolean without declaring which boolean.

## The three states, and the ENOTSUP / ENOENT distinction

| State | Meaning |
| --- | --- |
| `detected` | A source was consulted and said yes. |
| `not-present` | A source was consulted and said no. |
| `undetectable` | Nothing was learned. `reason` says why; `permanent` says whether a future macOS could change it. |

The subtle part is which failures are answers. A sysctl read that produces no value can fail two ways, and the errno is the only thing that separates them:

- **`ENOTSUP` (45) — the key IS published and the kernel declined to answer for this architecture.** That is a real answer: the node does not apply here. It maps to `not-present`. On an M4 Max, 29 keys behave this way, including `hw.optional.avx512f` — an x86 node the arm64 kernel still publishes by name.
- **`ENOENT` (2) — the kernel has never heard of the name.** Nothing is learned about the feature at all. It maps to `undetectable`, not `permanent`, because a future macOS release could publish the key.

Treating `ENOTSUP` as ignorance would be its own small lie, in the opposite direction from the one this package exists to remove. Two more populations on the same machine make the model concrete rather than theoretical: 18 keys exist, are readable, and report `0` — a real `not-present` with the zero on the evidence — while 29 return `ENOTSUP`.

Reading `has()` correctly matters here. It returns `true` only for `detected`, so it returns `false` for both `not-present` and `undetectable`. Read it as **not established**, not as absent. `detail()` tells you which, and on Apple Silicon there are exactly three capabilities where the difference bites: `amx`, `sve`, `sve2`.

## What is reliably detectable

**SME, including the datatype matrix.** Streaming vector length is read from `hw.optional.arm.sme_max_svl_b`: 64 bytes, 512 bits on an M4 Max. The datatypes are individually published, and on this part the answers are not uniform, which is exactly why a single `sme: true` flag is not enough:

| Datatype | State | Key |
| --- | --- | --- |
| `I8I32` | detected | `hw.optional.arm.SME_I8I32` |
| `I16I32` | detected | `hw.optional.arm.SME_I16I32` |
| `I16I64` | detected | `hw.optional.arm.FEAT_SME_I16I64` |
| `F16F32` | detected | `hw.optional.arm.SME_F16F32` |
| `F32F32` | detected | `hw.optional.arm.SME_F32F32` |
| `F64F64` | detected | `hw.optional.arm.FEAT_SME_F64F64` |
| `B16F32` | detected | `hw.optional.arm.SME_B16F32` |
| `BI32I32` | detected | `hw.optional.arm.SME_BI32I32` |
| `F16F16` | **not-present** | `hw.optional.arm.FEAT_SME_F16F16` |
| `B16B16` | **not-present** | `hw.optional.arm.FEAT_SME_B16B16` |

Note the two spellings. The kernel publishes some datatypes as `arm.SME_*` and others as `arm.FEAT_SME_*`, and which lives where is an implementation detail with no meaning to a caller. `caps.sme.supports()` accepts either, plus the bare datatype and the full key, because both spellings normalise onto the same capability id rather than being routed by a mapping table.

**GPU core count**, read from the IORegistry: the `gpu-core-count` property on the `AGXAccelerator` class (matched on the base class, since the concrete class is part-specific — `AGXAcceleratorG16X` on this machine). 40 cores on an M4 Max. This is a measurement, not a chip-name lookup table.

**CPU topology and cache geometry**, from real keys: 12 performance and 4 efficiency cores, 16 physical, 128-byte cache lines, 64 KiB L1d, 128 KiB L1i, 4 MiB L2, 64 GiB unified memory. The cache keys are published as 8-byte values on this kernel, including `hw.cachelinesize`; reading them as 4 bytes works by accident on little-endian and breaks the moment anything changes.

**Metal availability and device name**, through `MTLCreateSystemDefaultDevice`.

Most of the surface is discovered rather than declared: the native layer walks the `hw.optional` MIB subtree and turns each name it finds into an addressable capability. That yields 118 addressable ids on this machine, against 13 that the package documents by name. A discovered name cannot be a phantom, which is the point.

## The SVE prefix trap

`hw.optional.arm.FEAT_SVE_B16B16` exists on an M4 Max and reports `0`. `hw.optional.arm.FEAT_SVE` and `hw.optional.arm.FEAT_SVE2` do not exist at all.

So a detector that looks for a key *containing* or *starting with* `SVE` finds one, gets a successful read, and concludes that SVE is supported — on a machine with no SVE. Match key names exactly. This package reports `sve` and `sve2` as `undetectable` rather than `not-present`, because absence from a complete MIB walk proves the *key* is not published and does not by itself establish anything about the silicon. Callers who want vector width should ask about `sme` and read `sme.svlBits`.

## Portability: which ids are guaranteed to resolve

Only the 13 documented ids (`neon`, `sme`, `sme2`, `bf16`, `i8mm`, `dotprod`, `fp16`, `lse`, `sha3`, `metal`, `amx`, `sve`, `sve2`) always resolve. The other ~105 on this machine were discovered from *this* kernel's MIB and may legitimately not exist on another Mac or another macOS release.

That has a consequence worth being explicit about. `caps.has('cssc')` answers on an M4 Max, because this kernel publishes `FEAT_CSSC` and reports `0`. On a machine whose kernel does not publish that name, the same call **throws**. So:

```ts
caps.has('sme');                        // documented id: safe, and a typo throws
caps.has('cssc', { ifUnknown: false }); // discovered id: portable, default written down
caps.lookup('cssc');                    // CapabilityDetail | undefined, never throws
```

`has(id)` with no options keeps throwing `UNKNOWN_CAPABILITY` on an unrecognised id, deliberately. Returning `false` for a typo would make the typo a permanent, undiagnosable "feature absent" — the same defect this package was written to remove, relocated. Use the bare form for ids you know exist, so mistakes surface as errors; pass `ifUnknown` for the discovered long tail and for code that must run across macOS versions.

`ifUnknown` only governs ids that resolve to nothing. It cannot flip a real answer: `has('amx', { ifUnknown: true })` is still `false`, because `amx` is a known id whose state is `undetectable`. To choose a default for `undetectable` specifically, say so at the call site with `isEnabled(caps.detail(id), true)`.

There is no `detail(id, { ifUnknown })`. `detail()` returns a record carrying evidence, and the only way to return one for an id that does not exist is to invent the evidence. `lookup()` returns `undefined` instead, which is true.

## Depend on it as a peerDependency

This is a singleton by nature. Two copies at different versions in one dependency tree produce two independent detections, two memoized snapshots, and two potentially different answers about one machine — which is the problem this package exists to solve, reintroduced by the module graph. Libraries that consume it should declare it in `peerDependencies` so the application resolves exactly one copy:

```json
{
  "peerDependencies": {
    "@digitaldefiance/apple-silicon-caps": "^0.1.0"
  }
}
```

No package currently depends on it. This is a recommendation about how to consume it, not a description of existing adoption.

## API

`import caps from '@digitaldefiance/apple-silicon-caps'` gives the memoized, deep-frozen snapshot. `caps === detect()` always.

| Member | Returns | Notes |
| --- | --- | --- |
| `caps.has(id)` | `boolean` | `true` only for `detected`. Throws `UNKNOWN_CAPABILITY` for an unrecognised id. |
| `caps.has(id, { ifUnknown })` | `boolean` | Same, but an unrecognised id returns `ifUnknown` instead of throwing. |
| `caps.lookup(id)` | `CapabilityDetail \| undefined` | Never throws, for any input. |
| `caps.detail(id)` | `CapabilityDetail` | State, evidence or reason, and which key answered. Throws for an unrecognised id. |
| `caps.all()` | `readonly CapabilityDetail[]` | Every capability, registration order. |
| `caps.ids()` | `readonly string[]` | Every addressable id, sorted. |
| `caps.raw()` | `NativePayload` | The untouched native payload. Paste into a bug report. |
| `caps.assertRequired([...])` | `void` | Opt-in enforcement. Throws `UNSUPPORTED_PLATFORM` listing each shortfall and its reason. |
| `caps.sme.available` / `.sme2` / `.sme2p1` | `boolean` | |
| `caps.sme.svlBits` / `.svlBytes` | `number \| null` | `null` when not established. |
| `caps.sme.supports(datatype)` | `boolean` | Accepts either kernel naming scheme, any case, prefixed or bare. |
| `caps.sme.detail(datatype)` | `SmeDatatype` | Includes which key and which naming scheme answered. |
| `caps.sme.datatypes` | `readonly SmeDatatype[]` | The full matrix. |
| `caps.gpu.cores` / `.metal` / `.deviceName` | `number \| null`, `boolean`, `string \| null` | |
| `caps.cpu`, `caps.cache`, `caps.memory` | topology objects | Each has a `.readings` sibling carrying the evidence. |
| `caps.chip` | `string \| null` | **Informational only.** No capability is derived from it and none may be. |
| `detect()` | `Caps` | The same frozen object every call. |
| `canonicalSnapshot()` | `CanonicalSnapshot` | Sorted `name=state` pairs plus a SHA-256 digest. States only, never values, so two identical machines agree. |
| `checkConformance(report, opts?)` | `ConformanceViolation[]` | Compare another package's capability report against these answers. |
| `queriedSysctlKeys()` | `readonly string[]` | Every key queried BY NAME, straight from the addon. |
| `formatReport(caps?)` | `string` | The human-readable report the CLI prints. |
| `isEnabled(cap, whenUndetectable)` | `boolean` | Collapse a capability with the default stated at the call site. |
| `mapProbe(input)` | `Capability` | The whole state decision, exported so it can be tested and audited in isolation. |
| `CapsError`, `CapsErrorCode` | | `NATIVE_LOAD_FAILED`, `UNSUPPORTED_PLATFORM`, `MANIFEST_DESYNC`, `UNKNOWN_CAPABILITY`. |

A failed probe is data and lands in the snapshot as `undetectable`. A failed addon load is an error and throws immediately: silently degrading to an all-undetectable snapshot would hide a packaging bug behind exactly the answer this package is supposed to make trustworthy.

## CLI

```
apple-silicon-caps                  human-readable report: state AND evidence for everything
apple-silicon-caps --json           machine-readable, stable shape
apple-silicon-caps --raw            the untouched native payload, for bug reports
apple-silicon-caps --check <cap>    exit 0 if DETECTED, 1 otherwise
apple-silicon-caps --digest         the canonical snapshot digest only
apple-silicon-caps --help
```

Exit codes: `0` success or `--check` found a detected capability; `1` `--check` found something not established; `2` usage error, unknown capability, or detection failed. `--check` treats `undetectable` as failure, because it has not been established. `--help` works even on a broken install — the addon is imported after argument parsing.

## Platform support

arm64 macOS is the tested target; the numbers quoted throughout this file were measured on an M4 Max.

**x64 is compile-verified but UNTESTED at runtime.** `binding.gyp` builds an x86_64 slice and `caps.mm` gates its ARM-specific interpretation on a compile-time constant, so an x64 build loads and reports that this is not Apple Silicon, with an empty SME block and an unavailable GPU count. That path has never been executed, because no Intel Mac was available. Treat it as best-effort. If you run it, the output of `apple-silicon-caps --raw` in a bug report is the useful thing.

## Licence

MIT. Copyright (c) 2025 Digital Defiance, Jessica Mulein. See [LICENSE](./LICENSE).
