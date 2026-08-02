#!/usr/bin/env bash
#
# Prove the PUBLISHED ARTIFACT loads.
#
# "It works in the repo" is not evidence. The repo has build/ and node_modules/
# and every source file; the tarball has only what the "files" allowlist in
# package.json lets through. That gap is not hypothetical: it is exactly what
# shipped @digitaldefiance/node-rs-accelerate@0.1.2 broken. That tarball had 46
# files, its dist/gf.js required ../build/Release/node_rs_accelerate.node, the
# addon was absent from the tarball AND could not be rebuilt from it because the
# native sources had been excluded too. Every consumer got a hard module-load
# failure on require. The repo's own test suite passed the whole time.
#
# So this script never touches the repo after packing. It packs, extracts into a
# temp directory with no path back to this checkout's build/ or node_modules/,
# installs the tarball there as a consumer would, and then asserts on what it
# can actually observe from outside.
#
# Run it before every publish. `npm run verify:pack`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workdir=""

cleanup() {
  if [[ -n "${workdir}" && -d "${workdir}" ]]; then
    rm -rf "${workdir}"
  fi
  if [[ -n "${tarball_in_repo:-}" && -f "${tarball_in_repo}" ]]; then
    rm -f "${tarball_in_repo}"
  fi
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$1"; }

say "repo: ${repo_root}"

# ---------------------------------------------------------------------------
# 1. Build dist/, then pack.
#
# dist/ is gitignored but IS in the "files" allowlist, so packing without
# building ships an empty dist and the tarball's main entry point does not
# exist. package.json has a prepack hook for this; the explicit build here means
# the script is correct even if someone removes the hook.
# ---------------------------------------------------------------------------
say "building dist/"
cd "${repo_root}"
npm run --silent build:ts

if [[ ! -f "${repo_root}/dist/index.js" ]]; then
  echo "FAIL: dist/index.js does not exist after build:ts; nothing to pack." >&2
  exit 1
fi

say "npm pack"
tarball_name="$(npm pack --silent)"
tarball_in_repo="${repo_root}/${tarball_name}"
if [[ ! -f "${tarball_in_repo}" ]]; then
  echo "FAIL: npm pack reported '${tarball_name}' but no such file exists." >&2
  exit 1
fi
printf 'tarball: %s (%s bytes, %s files)\n' \
  "${tarball_name}" \
  "$(wc -c < "${tarball_in_repo}" | tr -d ' ')" \
  "$(tar -tzf "${tarball_in_repo}" | grep -c -v '/$')"

# ---------------------------------------------------------------------------
# 2. A consumer directory with no relationship to this checkout.
#
# mktemp puts this under $TMPDIR, not under /Volumes/Code, so node's module
# resolution cannot walk up into this repo's node_modules and quietly satisfy
# something the tarball forgot to ship.
# ---------------------------------------------------------------------------
workdir="$(mktemp -d "${TMPDIR:-/tmp}/asc-verify-pack.XXXXXXXX")"
consumer="${workdir}/consumer"
mkdir -p "${consumer}"
cp "${tarball_in_repo}" "${workdir}/${tarball_name}"

say "clean consumer: ${consumer}"

cat > "${consumer}/package.json" <<'JSON'
{
  "name": "asc-verify-pack-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
JSON

# ---------------------------------------------------------------------------
# 3. Install the tarball the way a consumer does.
#
# This runs the package's own install script, so a missing binding.gyp or a
# missing native source shows up here rather than in someone else's CI.
# ---------------------------------------------------------------------------
say "npm install ${tarball_name}"
cd "${consumer}"
npm install --no-audit --no-fund --loglevel=error "${workdir}/${tarball_name}"

installed="${consumer}/node_modules/@digitaldefiance/apple-silicon-caps"
if [[ ! -d "${installed}" ]]; then
  echo "FAIL: the package is not present under node_modules after install." >&2
  exit 1
fi

say "installed tree (top level)"
ls -1 "${installed}"

# ---------------------------------------------------------------------------
# 4. Load it and assert. From the consumer, through the package name.
# ---------------------------------------------------------------------------
cat > "${consumer}/check.mjs" <<'MJS'
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok    ${label}${detail === undefined ? '' : ` (${detail})`}`);
  } else {
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` (${detail})`}`);
    failures.push(label);
  }
};

const mod = await import('@digitaldefiance/apple-silicon-caps');
const caps = mod.default;

// Where did this actually load from? If it somehow resolved back into the
// development checkout, every assertion below would be meaningless.
const loadedFrom = fileURLToPath(new URL('.', import.meta.resolve('@digitaldefiance/apple-silicon-caps')));
const expectedRoot = resolve(process.cwd(), 'node_modules/@digitaldefiance/apple-silicon-caps');
check(
  'loaded from the installed tarball, not from a source checkout',
  loadedFrom.startsWith(expectedRoot),
  loadedFrom,
);

// The native addon loaded. If it had not, detect() would have thrown on import
// and nothing below would run - which is the point of throwing there.
check('the native addon loaded', typeof caps.raw === 'function');

// neon is detected: a positive answer, from a real key, end to end.
const neon = caps.detail('neon');
check('neon is detected', neon.state === 'detected', `${neon.state} via ${neon.sysctlKey}`);

// amx is undetectable and permanently so: the negative result survives packing.
const amx = caps.detail('amx');
check(
  'amx is undetectable and permanent',
  amx.state === 'undetectable' && amx.permanent === true,
  amx.state,
);
check('amx is never reported as detected', caps.has('amx') === false);

// The MIB walk ran inside the installed copy, so the enumerated surface is
// non-empty. An empty surface would mean the addon loaded but detection is dead.
const raw = caps.raw();
check('the sysctl walk succeeded', raw.enumerationOk === true);
check('the enumerated surface is non-empty', raw.enumerated.length > 0, `${raw.enumerated.length} readable`);
check('the capability catalogue is non-empty', caps.ids().length > 0, `${caps.ids().length} ids`);

// GPU cores came out of the IORegistry, which means the IOKit framework link
// survived the source build inside the consumer directory.
check('gpu.cores is a number', typeof caps.gpu.cores === 'number', String(caps.gpu.cores));
check('sme.svlBits is a number or null', caps.sme.svlBits === null || typeof caps.sme.svlBits === 'number', String(caps.sme.svlBits));

// The portability surface, from the published artifact.
check('lookup() returns undefined for an absent id', caps.lookup('future_feat_xyz') === undefined);
check('has(id, { ifUnknown }) honours the default', caps.has('future_feat_xyz', { ifUnknown: true }) === true);
let threw = false;
try {
  caps.has('future_feat_xyz');
} catch {
  threw = true;
}
check('bare has() still throws for an absent id', threw);

// Types shipped: a consumer on TypeScript needs these to exist as FILES.
const { existsSync } = await import('node:fs');
check('dist/index.d.ts shipped', existsSync(resolve(expectedRoot, 'dist/index.d.ts')));
check('dist/cli.js shipped', existsSync(resolve(expectedRoot, 'dist/cli.js')));

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed against the packed artifact.`);
  process.exit(1);
}
console.log('\nall assertions passed against the packed artifact');
MJS

say "assertions against the installed package"
node "${consumer}/check.mjs"

# ---------------------------------------------------------------------------
# 5. The CLI, through the bin npm installed. A symlink under node_modules/.bin,
#    which is why cli.ts resolves argv[1] with realpath before deciding whether
#    it is the program.
# ---------------------------------------------------------------------------
say "CLI: node_modules/.bin/apple-silicon-caps --help"
"${consumer}/node_modules/.bin/apple-silicon-caps" --help | head -3

say "CLI: --digest"
digest="$("${consumer}/node_modules/.bin/apple-silicon-caps" --digest)"
if [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FAIL: --digest did not print a sha256: '${digest}'" >&2
  exit 1
fi
printf 'digest: %s\n' "${digest}"

say "CLI: --check sme"
"${consumer}/node_modules/.bin/apple-silicon-caps" --check sme

say "CLI: report renders"
"${consumer}/node_modules/.bin/apple-silicon-caps" | head -5

printf '\n== PASS: the published artifact installs, loads and answers.\n'
