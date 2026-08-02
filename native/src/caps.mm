// caps.mm - the entire native surface of @digitaldefiance/apple-silicon-caps.
//
// STEP 1 SCOPE: this file is the whole detection layer. There is no TypeScript
// public API yet. Everything here returns RAW outcomes; interpretation into the
// three-state public model (detected / not-present / undetectable) happens in
// TypeScript later. The native layer is deliberately dumber than the public
// API, because a dumb layer cannot lie by omission.
//
// What it does:
//
//   1. Walks the sysctl MIB under `hw.optional` and reports every key it finds
//      with the value the kernel returned. It does NOT consult a hardcoded
//      list of feature keys. A hardcoded list can name a key that does not
//      exist -- which is exactly the defect this package was written to remove
//      (see hw.optional.amx_version below). An ENUMERATED SURFACE CANNOT
//      CONTAIN A PHANTOM KEY: every name in it came from the kernel.
//   2. Probes a manifest of non-`hw.optional` topology keys BY NAME, reporting
//      a three-way outcome: key absent / key present and zero / key present
//      and non-zero. Widths of 4 and 8 bytes are both handled explicitly.
//   3. Asks Metal whether a default device exists, through the real API.
//   4. Reads the GPU core count out of the IORegistry (AGXAccelerator ->
//      "gpu-core-count"). A measurement, not an inference from a chip-name
//      table. There is no chip-name table anywhere in this package.
//   5. Derives the SME detail block FROM THE ENUMERATION, not from a second
//      hardcoded key list.
//
// ---------------------------------------------------------------------------
// DELIBERATELY ABSENT KEYS -- never query these, never add them
// ---------------------------------------------------------------------------
//
//   hw.optional.amx_version     Does not exist. Queried by
//                               node-fhe-accelerate, whose failed query was
//                               read as "AMX absent".
//   hw.optional.arm.FEAT_SVE    Does not exist. Apple's SME is
//                               streaming-only; there is no plain SVE.
//   hw.optional.arm.FEAT_SVE2   Does not exist. Queried by
//                               node-zk-accelerate, same misreading.
//
// These three names appear in this file ONLY inside kPhantomKeys, which is
// reported to the caller as documentation and is never passed to any sysctl
// call. Their non-existence is established by their ABSENCE FROM THE
// ENUMERATION, which is stronger evidence than a failed query: a failed query
// is indistinguishable from a dozen other errno values, while absence from a
// complete walk of the subtree is proof.
//
// ---------------------------------------------------------------------------
// THE SVE PREFIX TRAP
// ---------------------------------------------------------------------------
//
// `hw.optional.arm.FEAT_SVE_B16B16` DOES exist on this machine, with value 0.
// `hw.optional.arm.FEAT_SVE` and `hw.optional.arm.FEAT_SVE2` DO NOT exist.
//
// A detector that decides "SVE is supported" by looking for a key whose name
// starts with or contains "SVE" will find FEAT_SVE_B16B16, conclude SVE
// exists, and be wrong twice over: the key it matched reports 0, and the
// feature it claims to have found has no key at all.
//
// The rule this file follows: PREFIX MATCHING IS FOR GROUPING A FAMILY FOR
// DISPLAY. EXACT MATCHING IS FOR CONCLUDING A FEATURE. The SME block below
// groups by prefix (safe, it is only assembling a report) and then answers
// individual questions by exact leaf name (safe, no near-miss can satisfy it).
// `sveKeysFound` reports every SVE-ish name the walk actually produced, so a
// reader can see the trap rather than being told about it.
//
// ---------------------------------------------------------------------------
// THE AMX GUARD
// ---------------------------------------------------------------------------
//
// The MIB walk discovers names before it reads values. Any discovered name
// containing "amx" (case-insensitive) is reported by name in `skippedKeys` and
// its value is NEVER read. That makes "no key containing amx is ever queried"
// a structural property of this translation unit rather than a promise in a
// comment. On this machine the list is empty, because no such key exists.
//
// ---------------------------------------------------------------------------
// NON-APPLE-SILICON TOLERANCE
// ---------------------------------------------------------------------------
//
// This file must COMPILE, LOAD and ANSWER HONESTLY on an Intel Mac. A
// detection library is the one thing that should always install. ARM-specific
// interpretation is gated on kIsArm64 so an x64 build reports an empty SME
// block and an absent arm-caps blob rather than fabricating either. The MIB
// walk itself is architecture-neutral: on x64 it enumerates the x86 feature
// keys, which is the correct answer for that machine. IOKit and Metal calls
// are the same calls on both architectures and degrade to "unavailable".

#include <napi.h>

#include <sys/types.h>
#include <sys/sysctl.h>

#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>

// IOMainPort was renamed in macOS 12. Keep both spellings so an older SDK
// still compiles -- relevant for the x64 build, which may be produced on an
// older toolchain than the arm64 one.
#if defined(MAC_OS_VERSION_12_0) && \
    (defined(__MAC_OS_X_VERSION_MIN_REQUIRED) && __MAC_OS_X_VERSION_MIN_REQUIRED >= 120000)
#define ASC_IO_MAIN_PORT kIOMainPortDefault
#else
#define ASC_IO_MAIN_PORT kIOMasterPortDefault
#endif

namespace {

// ---------------------------------------------------------------------------
// Compile-time architecture. Not derived from the brand string. Not derived
// from anything at runtime. This is what the binary was built for.
// ---------------------------------------------------------------------------
#if defined(__aarch64__) || defined(__arm64__)
constexpr bool kIsArm64 = true;
constexpr const char* kBuildArch = "arm64";
#elif defined(__x86_64__)
constexpr bool kIsArm64 = false;
constexpr const char* kBuildArch = "x64";
#else
constexpr bool kIsArm64 = false;
constexpr const char* kBuildArch = "unknown";
#endif

// ---------------------------------------------------------------------------
// The manifest. The ONLY place a sysctl key name is written by hand.
// Everything under hw.optional.* is discovered, not listed.
// ---------------------------------------------------------------------------

// Non-hw.optional integer keys, probed by name with a three-way outcome.
// These are not in an enumerable feature subtree, so they must be named.
constexpr const char* kTopologyKeys[] = {
    "hw.memsize",                   // 8 bytes here
    "hw.physicalcpu",               // 4 bytes here
    "hw.logicalcpu",                // 4 bytes here
    "hw.perflevel0.physicalcpu",    // 4 bytes here -- performance cores
    "hw.perflevel1.physicalcpu",    // 4 bytes here -- efficiency cores
    "hw.l1dcachesize",              // 8 bytes here
    "hw.l1icachesize",              // 8 bytes here
    "hw.l2cachesize",               // 8 bytes here
    "hw.cachelinesize",             // 8 bytes here
    "hw.pagesize",                  // 8 bytes here
};
// The widths above are what THIS kernel returned, verified against
// scripts/dump.mjs, not what one would guess. Every cache key is 8 bytes,
// including hw.cachelinesize, whose value is 128; the core counts are 4. That
// asymmetry is the reason ProbeByName narrows by the length the kernel reported
// instead of assuming a width. These comments are documentation of a
// measurement, so they are only as good as the last time someone re-ran the
// dump -- the code does not depend on them.

// The MIB subtree that is enumerated wholesale.
constexpr const char* kEnumerationRoot = "hw.optional";

// Informational only. Read, reported, and NEVER used as evidence for any
// capability. See ReadBrandString.
constexpr const char* kBrandStringKey = "machdep.cpu.brand_string";

// The undocumented packed capability blob. Captured raw, never decoded.
constexpr const char* kArmCapsLeaf = "arm.caps";

// IORegistry source for the GPU core count.
constexpr const char* kGpuServiceClass = "AGXAccelerator";
constexpr const char* kGpuCoreProperty = "gpu-core-count";

// Reported to the caller purely as documentation. NEVER passed to sysctl.
// Grep this file for these strings: each appears exactly once, right here.
constexpr const char* kPhantomKeys[] = {
    "hw.optional.amx_version",
    "hw.optional.arm.FEAT_SVE",
    "hw.optional.arm.FEAT_SVE2",
};

// ---------------------------------------------------------------------------
// sysctl MIB plumbing -- the same three meta-operations `sysctl -a` uses.
// ---------------------------------------------------------------------------

constexpr int kCtlSysctl = 0;   // CTL_SYSCTL
constexpr int kOpName = 1;      // CTL_SYSCTL_NAME
constexpr int kOpNext = 2;      // CTL_SYSCTL_NEXT
constexpr int kOpName2Oid = 3;  // CTL_SYSCTL_NAME2OID

bool Name2Oid(const char* name, int* oid, size_t* oid_len) {
  int query[2] = {kCtlSysctl, kOpName2Oid};
  size_t len = CTL_MAXNAME * sizeof(int);
  if (sysctl(query, 2, oid, &len,
             const_cast<void*>(static_cast<const void*>(name)),
             std::strlen(name)) != 0) {
    return false;
  }
  *oid_len = len / sizeof(int);
  return true;
}

bool Oid2Name(const int* oid, size_t oid_len, std::string* out) {
  int query[CTL_MAXNAME + 2];
  query[0] = kCtlSysctl;
  query[1] = kOpName;
  std::memcpy(query + 2, oid, oid_len * sizeof(int));

  char buf[512] = {0};
  size_t len = sizeof(buf);
  if (sysctl(query, static_cast<u_int>(oid_len + 2), buf, &len, nullptr, 0) != 0) {
    return false;
  }
  out->assign(buf);
  return true;
}

bool OidNext(const int* oid, size_t oid_len, int* next, size_t* next_len) {
  int query[CTL_MAXNAME + 2];
  query[0] = kCtlSysctl;
  query[1] = kOpNext;
  std::memcpy(query + 2, oid, oid_len * sizeof(int));

  size_t len = CTL_MAXNAME * sizeof(int);
  if (sysctl(query, static_cast<u_int>(oid_len + 2), next, &len, nullptr, 0) != 0) {
    return false;
  }
  *next_len = len / sizeof(int);
  return true;
}

// uint64 -> decimal string. Integer values cross the FFI boundary as strings
// because hw.optional.arm.caps carries 1152375837601820671 in its first eight
// bytes, which exceeds Number.MAX_SAFE_INTEGER and would silently lose
// precision as a double. A detection library that rounds its own output is not
// a detection library.
std::string U64ToString(uint64_t v) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(v));
  return std::string(buf);
}

std::string ToHex(const unsigned char* bytes, size_t n) {
  std::string out;
  out.reserve(2 + 2 * n);
  out.append("0x");
  static const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out.push_back(digits[(bytes[i] >> 4) & 0x0f]);
    out.push_back(digits[bytes[i] & 0x0f]);
  }
  return out;
}

bool ContainsCaseInsensitive(const std::string& haystack, const char* needle) {
  std::string h;
  h.reserve(haystack.size());
  for (char c : haystack) {
    h.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  }
  return h.find(needle) != std::string::npos;
}

bool StartsWith(const std::string& s, const char* prefix) {
  size_t n = std::strlen(prefix);
  return s.size() >= n && std::memcmp(s.data(), prefix, n) == 0;
}

// ---------------------------------------------------------------------------
// A value read out of the MIB.
// ---------------------------------------------------------------------------

struct OidValue {
  size_t width = 0;         // bytes the kernel actually returned
  bool is_scalar = false;   // true only for widths of 1, 2, 4 or 8 bytes
  uint64_t integer = 0;     // meaningful only when is_scalar
  uint64_t leading_u64 = 0; // first min(width, 8) bytes, little-endian
  std::string hex;          // every returned byte, in the order returned
  int err = 0;              // errno when the read failed; see RawProbe::err
};

// Reads a node by OID. Returns false when the node exists in the MIB but
// cannot be read -- which happens for the x86-only stubs the arm64 kernel
// still advertises (hw.optional.avx512f and friends).
//
// Not every hw.optional node is a scalar. `hw.optional.arm.caps` is TWELVE
// bytes wide on this machine, so there is no single integer that represents it.
// `sysctl -n hw.optional.arm.caps` prints 1152375837601820671, which is only
// the LEADING 64 BITS of a 96-bit blob whose layout Apple has not published.
// Both are reported: `leading_u64` for continuity with what the CLI shows, and
// `hex` for the whole thing. Nothing is decoded. Decoding an undocumented
// bitfield is guessing with extra steps.
bool ReadOid(int* oid, size_t oid_len, OidValue* out) {
  // Ask for the size first so an unexpectedly large node is reported by width
  // rather than as unreadable.
  size_t needed = 0;
  errno = 0;
  if (sysctl(oid, static_cast<u_int>(oid_len), nullptr, &needed, nullptr, 0) != 0) {
    out->err = errno;
    return false;
  }

  unsigned char buf[256];
  std::memset(buf, 0, sizeof(buf));
  size_t len = sizeof(buf);
  if (needed > sizeof(buf)) {
    // Honest partial: record the true width, read what fits.
    len = sizeof(buf);
  }
  errno = 0;
  if (sysctl(oid, static_cast<u_int>(oid_len), buf, &len, nullptr, 0) != 0) {
    out->err = errno;
    return false;
  }
  if (len == 0) {
    out->err = EOVERFLOW;
    return false;
  }

  out->width = len;
  out->hex = ToHex(buf, len);
  std::memcpy(&out->leading_u64, buf, len < 8 ? len : 8);

  switch (len) {
    case 1:
    case 2:
    case 4:
    case 8:
      // Widths the kernel publishes scalars at. leading_u64 IS the value.
      out->integer = out->leading_u64;
      out->is_scalar = true;
      break;
    default:
      // Opaque. Reported by width, leading bits and raw bytes; never decoded.
      out->is_scalar = false;
      break;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Three-way probe by name, for keys that are not in an enumerable subtree.
// ---------------------------------------------------------------------------

enum class ProbeOutcome : int32_t {
  kAbsentKey = -1,  // sysctlbyname failed: the key is not in this kernel's MIB
  kZero = 0,        // key exists, value 0
  kNonZero = 1,     // key exists, value non-zero
};

struct RawProbe {
  ProbeOutcome outcome = ProbeOutcome::kAbsentKey;
  uint64_t value = 0;
  size_t width = 0;
  int err = 0;  // errno when outcome == kAbsentKey; see the note below
};

// WHY errno IS CARRIED ALONGSIDE THE THREE-WAY OUTCOME
//
// Measured on this machine, a failing read has two distinct causes:
//
//   hw.optional.arm.FEAT_SVE  -> rc=-1 errno=2  ENOENT   name not in the MIB
//   hw.optional.avx512f       -> rc=-1 errno=45 ENOTSUP  name IS in the MIB,
//                                                        node not readable on
//                                                        this architecture
//
// Both are ABSENT_KEY as far as "did we get a value" goes, and the three-way
// outcome deliberately keeps them together, because in both cases NO VALUE WAS
// OBTAINED and inventing one is the defect. But they are not the same fact, and
// the layer above should be able to tell them apart: ENOENT means "this kernel
// has never heard of the thing you asked about", while ENOTSUP means "this
// kernel publishes the name and is telling you it does not apply here". Only
// errno distinguishes them, so errno crosses the boundary. Interpretation stays
// upstairs.

// The distinction between `rc != 0` and `value == 0` is the entire reason this
// function exists. Collapsing the two is the original defect: it reports
// "feature absent" for a question that was never successfully asked.
//
// Width handling is explicit rather than incidental. Several hw.* keys are
// published as 32-bit (hw.physicalcpu, hw.perflevel0.physicalcpu) and others as
// 64-bit (hw.memsize, every hw.l*cachesize, and surprisingly hw.cachelinesize,
// whose value is 128 and fits in a byte). Reading eight bytes into an
// int64 and assuming happens to work on little-endian arm64 because the buffer
// is zero-initialised, but it is an accident, not a guarantee, and it is wrong
// the moment anything is big-endian or the buffer is reused. Narrow by the
// length the kernel reported.
RawProbe ProbeByName(const char* key) {
  unsigned char buf[8];
  std::memset(buf, 0, sizeof(buf));
  size_t len = sizeof(buf);

  errno = 0;
  if (sysctlbyname(key, buf, &len, nullptr, 0) != 0) {
    // No value was obtained, so we know NOTHING about whatever the key
    // describes. This is the branch hw.optional.amx_version and FEAT_SVE2 land
    // in, and the branch eight audited detectors mapped to `false`. errno is
    // carried so the layer above can separate ENOENT from ENOTSUP.
    return RawProbe{ProbeOutcome::kAbsentKey, 0, 0, errno};
  }
  if (len == 0 || len > sizeof(buf)) {
    // Present but not an integer of a width this function handles. Report no
    // value rather than inventing a number. EOVERFLOW is used as the marker
    // because the failure is one of width, not of existence.
    return RawProbe{ProbeOutcome::kAbsentKey, 0, len, EOVERFLOW};
  }

  uint64_t value = 0;
  std::memcpy(&value, buf, len);

  return RawProbe{value != 0 ? ProbeOutcome::kNonZero : ProbeOutcome::kZero,
                  value, len, 0};
}

// ---------------------------------------------------------------------------
// GPU core count, measured from the IORegistry.
// ---------------------------------------------------------------------------

struct GpuCoreResult {
  bool ok = false;
  int64_t value = 0;
  std::string matched_class;
  std::string reason;  // populated only when !ok
};

// Reads AGXAccelerator's "gpu-core-count" property directly through IOKit.
// It does NOT shell out to the `ioreg` CLI -- a library that forks a process
// to answer a question it can ask an API is a library with a PATH dependency
// and a sandbox failure mode. It also does NOT consult a table of chip names.
//
// IOServiceMatching matches subclasses, which matters: the concrete class on
// this machine is AGXAcceleratorG16X, not AGXAccelerator.
//
// On failure the caller reports unavailable with this reason. There is no
// fallback to a table or a literal. node-fhe-accelerate's
// get_metal_gpu_cores() returns the literal 40 with a `// Placeholder`
// comment; correct on an M4 Max and wrong by 4x on an M4 base.
GpuCoreResult ReadGpuCoreCount() {
  GpuCoreResult result;

  CFMutableDictionaryRef matching = IOServiceMatching(kGpuServiceClass);
  if (matching == nullptr) {
    result.reason = std::string("IOServiceMatching(\"") + kGpuServiceClass +
                    "\") returned NULL; no matching dictionary could be built.";
    return result;
  }

  io_iterator_t iter = IO_OBJECT_NULL;
  // IOServiceGetMatchingServices consumes `matching` on every path, success or
  // failure. Do not CFRelease it here.
  kern_return_t kr = IOServiceGetMatchingServices(ASC_IO_MAIN_PORT, matching, &iter);
  if (kr != KERN_SUCCESS) {
    result.reason = std::string("IOServiceGetMatchingServices for class ") +
                    kGpuServiceClass + " failed with kern_return_t " +
                    U64ToString(static_cast<uint64_t>(kr)) + ".";
    return result;
  }

  CFStringRef prop_name = CFStringCreateWithCString(
      kCFAllocatorDefault, kGpuCoreProperty, kCFStringEncodingUTF8);
  if (prop_name == nullptr) {
    IOObjectRelease(iter);
    result.reason = "CFStringCreateWithCString failed for the property name.";
    return result;
  }

  bool found_service = false;
  io_registry_entry_t entry = IO_OBJECT_NULL;
  while ((entry = IOIteratorNext(iter)) != IO_OBJECT_NULL) {
    found_service = true;

    if (result.matched_class.empty()) {
      io_name_t cls = {0};
      if (IOObjectGetClass(entry, cls) == KERN_SUCCESS) {
        result.matched_class.assign(cls);
      }
    }

    CFTypeRef prop = IORegistryEntryCreateCFProperty(entry, prop_name,
                                                     kCFAllocatorDefault, 0);
    if (prop != nullptr) {
      CFTypeID type = CFGetTypeID(prop);
      if (type == CFNumberGetTypeID()) {
        int64_t v = 0;
        if (CFNumberGetValue(static_cast<CFNumberRef>(prop),
                             kCFNumberSInt64Type, &v)) {
          result.ok = true;
          result.value = v;
        }
      } else if (type == CFDataGetTypeID()) {
        // Some IORegistry integers are published as raw little-endian data.
        CFDataRef data = static_cast<CFDataRef>(prop);
        CFIndex n = CFDataGetLength(data);
        if (n > 0 && n <= 8) {
          uint64_t v = 0;
          CFDataGetBytes(data, CFRangeMake(0, n), reinterpret_cast<UInt8*>(&v));
          result.ok = true;
          result.value = static_cast<int64_t>(v);
        }
      }
      CFRelease(prop);
    }

    IOObjectRelease(entry);
    if (result.ok) break;
  }

  CFRelease(prop_name);
  IOObjectRelease(iter);

  if (!result.ok) {
    if (!found_service) {
      result.reason = std::string("No IORegistry service of class ") +
                      kGpuServiceClass +
                      " was found, so the GPU core count cannot be read. "
                      "Expected on a Mac with no Apple GPU.";
    } else {
      result.reason = std::string("IORegistry class ") + kGpuServiceClass +
                      " exists but published no readable integer property \"" +
                      kGpuCoreProperty + "\".";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Brand string.
//
// INFORMATIONAL ONLY. NO CAPABILITY MAY BE DERIVED FROM THIS STRING, HERE OR
// IN ANY LAYER ABOVE. Brand-string inference is the specific defect this
// package exists to remove: four of the eight audited detectors decided a
// feature was present because strstr(brand, "Apple") or strstr(brand, "M4")
// succeeded, which establishes only that the machine is a Mac. It is returned
// so a bug report can say which machine produced a given dump, and for no
// other purpose.
// ---------------------------------------------------------------------------
std::string ReadBrandString() {
  char brand[256];
  std::memset(brand, 0, sizeof(brand));
  size_t len = sizeof(brand);
  if (sysctlbyname(kBrandStringKey, brand, &len, nullptr, 0) != 0) {
    return std::string();
  }
  brand[sizeof(brand) - 1] = '\0';
  return std::string(brand);
}

// ---------------------------------------------------------------------------
// Enumeration record, kept so later blocks can be DERIVED from the walk rather
// than from a second hardcoded key list.
// ---------------------------------------------------------------------------

struct EnumEntry {
  std::string key;   // full name, e.g. hw.optional.arm.FEAT_SME2
  std::string leaf;  // name below the root, e.g. arm.FEAT_SME2
  OidValue value;
};

// Exact-match lookup by leaf name. EXACT, because this is the function that
// ANSWERS A QUESTION ABOUT A FEATURE, and near misses are the SVE trap.
const EnumEntry* FindLeaf(const std::vector<EnumEntry>& entries, const char* leaf) {
  for (const EnumEntry& e : entries) {
    if (e.leaf == leaf) return &e;
  }
  return nullptr;
}

Napi::Array LeafScalar(Napi::Env env, const std::vector<EnumEntry>& entries,
                       const char* leaf) {
  // [leaf, outcome, value] using the same three-way encoding as ProbeByName.
  // Absence here means "the walk did not produce this name", which is a
  // stronger statement than "a query for it failed".
  Napi::Array out = Napi::Array::New(env, 3);
  const EnumEntry* e = FindLeaf(entries, leaf);
  out.Set(0u, Napi::String::New(env, leaf));
  if (e == nullptr || !e->value.is_scalar) {
    out.Set(1u, Napi::Number::New(env, static_cast<int32_t>(ProbeOutcome::kAbsentKey)));
    out.Set(2u, Napi::String::New(env, ""));
    return out;
  }
  out.Set(1u, Napi::Number::New(
                  env, static_cast<int32_t>(e->value.integer != 0
                                                ? ProbeOutcome::kNonZero
                                                : ProbeOutcome::kZero)));
  out.Set(2u, Napi::String::New(env, U64ToString(e->value.integer)));
  return out;
}

// ---------------------------------------------------------------------------
// N-API entry point
// ---------------------------------------------------------------------------

Napi::Value CapsDetect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  result.Set("nativeSchemaVersion", Napi::Number::New(env, 1));
  result.Set("buildArch", Napi::String::New(env, kBuildArch));
  result.Set("isArm64Build", Napi::Boolean::New(env, kIsArm64));

  // -----------------------------------------------------------------------
  // 1. Enumerate the hw.optional subtree.
  // -----------------------------------------------------------------------
  std::vector<EnumEntry> entries;
  Napi::Array unreadable = Napi::Array::New(env);
  Napi::Array skipped = Napi::Array::New(env);
  uint32_t unreadable_n = 0, skipped_n = 0, discovered_n = 0;

  int root[CTL_MAXNAME] = {0};
  size_t root_len = 0;
  const bool root_ok = Name2Oid(kEnumerationRoot, root, &root_len);
  const std::string root_prefix = std::string(kEnumerationRoot) + ".";

  if (root_ok) {
    int cur[CTL_MAXNAME] = {0};
    size_t cur_len = root_len;
    std::memcpy(cur, root, root_len * sizeof(int));

    for (;;) {
      int next[CTL_MAXNAME] = {0};
      size_t next_len = 0;
      if (!OidNext(cur, cur_len, next, &next_len)) break;
      // Stop as soon as the walk leaves the subtree.
      if (next_len < root_len ||
          std::memcmp(next, root, root_len * sizeof(int)) != 0) {
        break;
      }

      std::string name;
      if (!Oid2Name(next, next_len, &name)) break;
      discovered_n++;

      if (ContainsCaseInsensitive(name, "amx")) {
        // Name reported, value NEVER read. See THE AMX GUARD at the top. The
        // guard is placed BEFORE the read, so it is not possible for an AMX
        // value to exist in this process.
        skipped.Set(skipped_n++, Napi::String::New(env, name));
      } else {
        EnumEntry e;
        e.key = name;
        e.leaf = StartsWith(name, root_prefix.c_str())
                     ? name.substr(root_prefix.size())
                     : name;
        if (ReadOid(next, next_len, &e.value)) {
          entries.push_back(e);
        } else {
          // [key, errno, strerror]. On this machine every entry here is
          // ENOTSUP (45) on an x86-only node the arm64 kernel still advertises
          // by name -- hw.optional.avx512f and friends. That is a DIFFERENT
          // fact from ENOENT: the name exists, the kernel is declining to
          // answer for this architecture. Both yield no value; only errno says
          // which one happened.
          Napi::Array tuple = Napi::Array::New(env, 3);
          tuple.Set(0u, Napi::String::New(env, name));
          tuple.Set(1u, Napi::Number::New(env, e.value.err));
          tuple.Set(2u, Napi::String::New(env, std::strerror(e.value.err)));
          unreadable.Set(unreadable_n++, tuple);
        }
      }

      std::memcpy(cur, next, next_len * sizeof(int));
      cur_len = next_len;
    }
  }

  // Flat array of tuples of primitives. No nested objects, no JSON strings.
  //   [0] full key name
  //   [1] decimal value as a string, or "" when the node is not a scalar
  //   [2] byte width the kernel reported
  //   [3] every returned byte as hex
  Napi::Array enumerated = Napi::Array::New(env, entries.size());
  for (uint32_t i = 0; i < entries.size(); i++) {
    const EnumEntry& e = entries[i];
    Napi::Array tuple = Napi::Array::New(env, 4);
    tuple.Set(0u, Napi::String::New(env, e.key));
    tuple.Set(1u, Napi::String::New(
                      env, e.value.is_scalar ? U64ToString(e.value.integer) : ""));
    tuple.Set(2u, Napi::Number::New(env, static_cast<double>(e.value.width)));
    tuple.Set(3u, Napi::String::New(env, e.value.hex));
    enumerated.Set(i, tuple);
  }

  result.Set("enumerationRoot", Napi::String::New(env, kEnumerationRoot));
  result.Set("enumerationOk", Napi::Boolean::New(env, root_ok));
  result.Set("mibNamesDiscovered", Napi::Number::New(env, discovered_n));
  result.Set("enumerated", enumerated);
  result.Set("unreadableKeys", unreadable);
  result.Set("skippedKeys", skipped);

  // -----------------------------------------------------------------------
  // 2. Topology probes, by name, three-way, width-aware.
  // -----------------------------------------------------------------------
  Napi::Array probes = Napi::Array::New(env);
  uint32_t probe_n = 0;
  for (const char* key : kTopologyKeys) {
    RawProbe p = ProbeByName(key);
    // [key, outcome, value-as-string, width, errno, strerror]
    Napi::Array tuple = Napi::Array::New(env, 6);
    tuple.Set(0u, Napi::String::New(env, key));
    tuple.Set(1u, Napi::Number::New(env, static_cast<int32_t>(p.outcome)));
    tuple.Set(2u, Napi::String::New(env, U64ToString(p.value)));
    tuple.Set(3u, Napi::Number::New(env, static_cast<double>(p.width)));
    tuple.Set(4u, Napi::Number::New(env, p.err));
    tuple.Set(5u, Napi::String::New(env, p.err == 0 ? "" : std::strerror(p.err)));
    probes.Set(probe_n++, tuple);
  }
  result.Set("namedProbes", probes);

  // -----------------------------------------------------------------------
  // 3. The undocumented packed capability blob, captured and NOT decoded.
  // -----------------------------------------------------------------------
  Napi::Object arm_caps = Napi::Object::New(env);
  const EnumEntry* caps_entry = kIsArm64 ? FindLeaf(entries, kArmCapsLeaf) : nullptr;
  arm_caps.Set("key", Napi::String::New(
                          env, std::string(kEnumerationRoot) + "." + kArmCapsLeaf));
  arm_caps.Set("present", Napi::Boolean::New(env, caps_entry != nullptr));
  arm_caps.Set("widthBytes",
               Napi::Number::New(env, caps_entry != nullptr
                                          ? static_cast<double>(caps_entry->value.width)
                                          : 0));
  arm_caps.Set("hex", Napi::String::New(
                          env, caps_entry != nullptr ? caps_entry->value.hex : ""));
  arm_caps.Set("leadingU64",
               Napi::String::New(env, caps_entry != nullptr
                                          ? U64ToString(caps_entry->value.leading_u64)
                                          : ""));
  arm_caps.Set("decoded", Napi::Boolean::New(env, false));
  arm_caps.Set(
      "note",
      Napi::String::New(
          env,
          "Captured raw and deliberately not decoded. The bitfield layout is "
          "undocumented, so assigning meaning to any bit would be guessing "
          "with extra steps. Note the width: `sysctl -n hw.optional.arm.caps` "
          "prints only the leading 64 bits, so the CLI value is a truncation, "
          "not the whole blob. Use the enumerated per-feature keys instead -- "
          "they are documented, individually addressable, and already above."));
  result.Set("armCapsRaw", arm_caps);

  // -----------------------------------------------------------------------
  // 4. SME detail, DERIVED FROM THE ENUMERATION.
  //
  // Two naming schemes coexist and both must be handled:
  //   short-form   hw.optional.arm.SME_B16F32
  //   prefixed     hw.optional.arm.FEAT_SME_F64F64
  // plus the bare feature keys FEAT_SME / FEAT_SME2 / FEAT_SME2p1 and the
  // vector-length key sme_max_svl_b.
  //
  // The family list is collected BY PREFIX from the walk -- safe, because it
  // is only assembling a report and every name in it came from the kernel.
  // Individual questions are answered BY EXACT LEAF NAME via LeafScalar --
  // safe, because no near miss can satisfy an exact comparison. That is the
  // FEAT_SVE_B16B16 lesson applied in both directions.
  // -----------------------------------------------------------------------
  Napi::Object sme = Napi::Object::New(env);
  Napi::Array sme_family = Napi::Array::New(env);
  uint32_t sme_n = 0;
  if (kIsArm64) {
    for (const EnumEntry& e : entries) {
      const bool is_sme_family =
          StartsWith(e.leaf, "arm.SME_") || StartsWith(e.leaf, "arm.FEAT_SME") ||
          StartsWith(e.leaf, "arm.sme_");
      if (!is_sme_family) continue;
      Napi::Array pair = Napi::Array::New(env, 2);
      pair.Set(0u, Napi::String::New(env, e.key));
      pair.Set(1u, Napi::String::New(
                       env, e.value.is_scalar ? U64ToString(e.value.integer) : ""));
      sme_family.Set(sme_n++, pair);
    }
  }
  sme.Set("familyFromEnumeration", sme_family);
  sme.Set("derivedFrom", Napi::String::New(
                             env, "enumeration of hw.optional.* (no second key list)"));

  // Streaming vector length. Published in BYTES; bits are exposed too because
  // every consumer that has ever wanted this number wanted bits, and doing the
  // multiplication in eight places is how eight answers happen.
  Napi::Object svl = Napi::Object::New(env);
  const EnumEntry* svl_entry = kIsArm64 ? FindLeaf(entries, "arm.sme_max_svl_b") : nullptr;
  const bool svl_ok = svl_entry != nullptr && svl_entry->value.is_scalar;
  svl.Set("key", Napi::String::New(env, "hw.optional.arm.sme_max_svl_b"));
  svl.Set("present", Napi::Boolean::New(env, svl_ok));
  svl.Set("bytes", Napi::String::New(
                       env, svl_ok ? U64ToString(svl_entry->value.integer) : ""));
  svl.Set("bits", Napi::String::New(
                      env, svl_ok ? U64ToString(svl_entry->value.integer * 8) : ""));
  sme.Set("maxStreamingVectorLength", svl);

  // Exact-name answers. Both naming schemes, side by side, so the split is
  // visible in the dump rather than buried in a mapping table.
  Napi::Array sme_exact = Napi::Array::New(env);
  uint32_t ex = 0;
  static const char* kSmeExactLeaves[] = {
      // prefixed scheme
      "arm.FEAT_SME", "arm.FEAT_SME2", "arm.FEAT_SME2p1",
      "arm.FEAT_SME_F64F64", "arm.FEAT_SME_I16I64",
      "arm.FEAT_SME_F16F16", "arm.FEAT_SME_B16B16",
      // short-form scheme
      "arm.SME_B16F32", "arm.SME_BI32I32", "arm.SME_F16F32",
      "arm.SME_F32F32", "arm.SME_I16I32", "arm.SME_I8I32",
  };
  if (kIsArm64) {
    for (const char* leaf : kSmeExactLeaves) {
      sme_exact.Set(ex++, LeafScalar(env, entries, leaf));
    }
  }
  sme.Set("exact", sme_exact);
  result.Set("sme", sme);

  // -----------------------------------------------------------------------
  // 5. The SVE prefix trap, made visible rather than described.
  // -----------------------------------------------------------------------
  Napi::Object sve = Napi::Object::New(env);
  Napi::Array sve_found = Napi::Array::New(env);
  uint32_t sv = 0;
  for (const EnumEntry& e : entries) {
    if (!ContainsCaseInsensitive(e.leaf, "sve")) continue;
    Napi::Array pair = Napi::Array::New(env, 2);
    pair.Set(0u, Napi::String::New(env, e.key));
    pair.Set(1u, Napi::String::New(
                     env, e.value.is_scalar ? U64ToString(e.value.integer) : ""));
    sve_found.Set(sv++, pair);
  }
  sve.Set("keysContainingSve", sve_found);
  // Established by ABSENCE FROM THE WALK, not by querying the names.
  sve.Set("bareSveKeyPresent",
          Napi::Boolean::New(env, FindLeaf(entries, "arm.FEAT_SVE") != nullptr));
  sve.Set("sve2KeyPresent",
          Napi::Boolean::New(env, FindLeaf(entries, "arm.FEAT_SVE2") != nullptr));
  sve.Set("trap",
          Napi::String::New(
              env,
              "hw.optional.arm.FEAT_SVE_B16B16 exists and reports 0, while "
              "FEAT_SVE and FEAT_SVE2 do not exist at all. A prefix or "
              "substring match on \"SVE\" therefore FINDS A KEY and wrongly "
              "concludes SVE support. Match exactly. Note that these two "
              "names were never queried: their absence is read off the "
              "enumeration, which is why keysContainingSve can be non-empty "
              "while both flags above are false."));
  result.Set("sveTrap", sve);

  // -----------------------------------------------------------------------
  // 6. AMX. Never probed. The evidence is the absence of any such name.
  // -----------------------------------------------------------------------
  Napi::Object amx = Napi::Object::New(env);
  amx.Set("probed", Napi::Boolean::New(env, false));
  amx.Set("namesFoundInEnumeration", skipped);  // same array; empty here
  amx.Set("note",
          Napi::String::New(
              env,
              "No key containing \"amx\" is ever queried. The MIB walk "
              "discovers names before reading values, and any name containing "
              "\"amx\" is recorded and skipped before its value is read, so no "
              "AMX value can exist in this process. On Apple Silicon the list "
              "is empty because no such key exists in the MIB at all."));
  result.Set("amx", amx);

  // Documentation payload. These strings are never passed to sysctl.
  Napi::Array phantom = Napi::Array::New(env);
  uint32_t ph = 0;
  for (const char* key : kPhantomKeys) {
    phantom.Set(ph++, Napi::String::New(env, key));
  }
  result.Set("phantomKeysNeverQueried", phantom);

  // -----------------------------------------------------------------------
  // 7. Metal, through the real API rather than a guess from a model name.
  // -----------------------------------------------------------------------
  bool metal_available = false;
  std::string metal_name;
  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (device != nil) {
      metal_available = true;
      const char* n = [[device name] UTF8String];
      metal_name = std::string(n != nullptr ? n : "");
    }
  }
  result.Set("metalAvailable", Napi::Boolean::New(env, metal_available));
  result.Set("metalDeviceName", Napi::String::New(env, metal_name));
  result.Set("metalApi", Napi::String::New(env, "MTLCreateSystemDefaultDevice"));

  // -----------------------------------------------------------------------
  // 8. GPU core count, measured from the IORegistry.
  // -----------------------------------------------------------------------
  GpuCoreResult gpu = ReadGpuCoreCount();
  Napi::Object gpu_obj = Napi::Object::New(env);
  gpu_obj.Set("ok", Napi::Boolean::New(env, gpu.ok));
  gpu_obj.Set("value", Napi::Number::New(env, static_cast<double>(gpu.value)));
  gpu_obj.Set("ioClass", Napi::String::New(env, kGpuServiceClass));
  gpu_obj.Set("matchedClass", Napi::String::New(env, gpu.matched_class));
  gpu_obj.Set("property", Napi::String::New(env, kGpuCoreProperty));
  gpu_obj.Set("reason", Napi::String::New(env, gpu.reason));
  result.Set("gpuCoreCount", gpu_obj);

  // -----------------------------------------------------------------------
  // 9. Brand string. Informational only. See ReadBrandString.
  // -----------------------------------------------------------------------
  std::string brand = ReadBrandString();
  result.Set("cpuBrandString", Napi::String::New(env, brand));
  result.Set("cpuBrandStringKey", Napi::String::New(env, kBrandStringKey));
  result.Set("cpuBrandStringWarning",
             Napi::String::New(
                 env,
                 "INFORMATIONAL ONLY. No capability may be derived from this "
                 "string. Brand-string inference is the defect being removed."));

  return result;
}

Napi::Value CapsProbedKeys(const Napi::CallbackInfo& info) {
  // Every key this addon queries BY NAME. The enumerated subtree is not
  // listed, because it is discovered rather than named, and a discovered name
  // cannot be a phantom.
  Napi::Env env = info.Env();
  Napi::Array keys = Napi::Array::New(env);
  uint32_t i = 0;
  for (const char* key : kTopologyKeys) {
    keys.Set(i++, Napi::String::New(env, key));
  }
  keys.Set(i++, Napi::String::New(env, kBrandStringKey));
  return keys;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("caps_detect", Napi::Function::New(env, CapsDetect));
  exports.Set("caps_probed_keys", Napi::Function::New(env, CapsProbedKeys));
  return exports;
}

}  // namespace

NODE_API_MODULE(apple_silicon_caps, Init)
