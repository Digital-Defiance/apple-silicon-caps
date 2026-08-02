#!/usr/bin/env node
// Scratch dump script for STEP 1.
//
// It requires the built addon and prints everything it returns. It applies NO
// interpretation: no three-state model, no capability names, no verdicts. Those
// belong in the TypeScript layer in a later step, and putting even a little of
// that here would create a second place where interpretation lives.
//
// Usage: node scripts/dump.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const addon = require(join(root, 'build/Release/apple_silicon_caps.node'));

const raw = addon.caps_detect();
const namedKeys = addon.caps_probed_keys();

const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const pad = (s, n) => String(s).padEnd(n);

rule('BUILD / HOST');
console.log(`nativeSchemaVersion   ${raw.nativeSchemaVersion}`);
console.log(`buildArch             ${raw.buildArch}`);
console.log(`isArm64Build          ${raw.isArm64Build}`);
console.log(`process.arch          ${process.arch}`);
console.log(`process.platform      ${process.platform}`);
console.log(`node                  ${process.version}`);

rule('BRAND STRING (INFORMATIONAL ONLY)');
console.log(`${raw.cpuBrandStringKey} = ${JSON.stringify(raw.cpuBrandString)}`);
console.log(raw.cpuBrandStringWarning);

rule(`ENUMERATED SYSCTL SURFACE: ${raw.enumerationRoot}.*`);
console.log(`enumerationOk         ${raw.enumerationOk}`);
console.log(`mibNamesDiscovered    ${raw.mibNamesDiscovered}`);
console.log(`readable entries      ${raw.enumerated.length}`);
console.log(`unreadable keys       ${raw.unreadableKeys.length}`);
console.log(`skipped (amx guard)   ${raw.skippedKeys.length}`);
console.log('');
console.log(`${pad('KEY', 46)} ${pad('VALUE', 22)} ${pad('W', 3)} HEX`);
console.log('-'.repeat(78));
for (const [key, value, width, hex] of raw.enumerated) {
  const shown = value === '' ? '<non-scalar>' : value;
  console.log(`${pad(key, 46)} ${pad(shown, 22)} ${pad(width, 3)} ${hex}`);
}

if (raw.unreadableKeys.length > 0) {
  rule('DISCOVERED BUT UNREADABLE (name in the MIB, no value returned)');
  console.log(`${pad('KEY', 34)} ${pad('ERRNO', 7)} MEANING`);
  console.log('-'.repeat(78));
  for (const [key, err, msg] of raw.unreadableKeys) {
    console.log(`${pad(key, 34)} ${pad(err, 7)} ${msg}`);
  }
}

rule('COUNTS OVER THE ENUMERATED SURFACE');
const feat = raw.enumerated.filter(([k]) => k.startsWith('hw.optional.arm.FEAT_'));
const zeros = raw.enumerated.filter(([, v]) => v === '0');
const nonzero = raw.enumerated.filter(([, v]) => v !== '' && v !== '0');
const nonScalar = raw.enumerated.filter(([, v]) => v === '');
console.log(`total hw.optional keys        ${raw.enumerated.length}`);
console.log(`  hw.optional.arm.FEAT_*      ${feat.length}`);
console.log(`  reporting 0                 ${zeros.length}`);
console.log(`  reporting non-zero          ${nonzero.length}`);
console.log(`  non-scalar (raw bytes only) ${nonScalar.length}`);
console.log('');
console.log('keys reporting 0:');
for (const [k] of zeros) console.log(`  ${k}`);

rule('NAMED THREE-WAY PROBES (non-enumerable keys)');
console.log('outcome: -1 ABSENT_KEY (learned nothing) | 0 ZERO | 1 NONZERO');
console.log('');
console.log(`${pad('KEY', 30)} ${pad('OUTCOME', 12)} ${pad('VALUE', 14)} ${pad('W', 2)} ERRNO`);
console.log('-'.repeat(78));
const outcomeName = { '-1': 'ABSENT_KEY', 0: 'ZERO', 1: 'NONZERO' };
for (const [key, outcome, value, width, err, msg] of raw.namedProbes) {
  console.log(
    `${pad(key, 30)} ${pad(`${outcome} ${outcomeName[outcome]}`, 12)} ` +
      `${pad(outcome === -1 ? '-' : value, 14)} ${pad(width, 2)} ` +
      `${err === 0 ? '-' : `${err} ${msg}`}`,
  );
}

rule('KEYS QUERIED BY NAME (caps_probed_keys)');
for (const k of namedKeys) console.log(k);

rule('hw.optional.arm.caps (RAW, NOT DECODED)');
for (const [k, v] of Object.entries(raw.armCapsRaw)) {
  console.log(`${pad(k, 12)} ${v}`);
}

rule('SME DETAIL (derived from the enumeration)');
console.log(`derivedFrom  ${raw.sme.derivedFrom}`);
console.log('');
console.log('maxStreamingVectorLength:');
for (const [k, v] of Object.entries(raw.sme.maxStreamingVectorLength)) {
  console.log(`  ${pad(k, 10)} ${v}`);
}
console.log('');
console.log(`family found by prefix (${raw.sme.familyFromEnumeration.length} keys):`);
for (const [k, v] of raw.sme.familyFromEnumeration) {
  console.log(`  ${pad(k, 44)} ${v === '' ? '<non-scalar>' : v}`);
}
console.log('');
console.log('answers by EXACT leaf name:');
for (const [leaf, outcome, value] of raw.sme.exact) {
  console.log(
    `  ${pad(leaf, 26)} ${pad(`${outcome} ${outcomeName[outcome]}`, 12)} ` +
      `${outcome === -1 ? '-' : value}`,
  );
}

rule('SVE PREFIX TRAP');
console.log(`bareSveKeyPresent (FEAT_SVE)   ${raw.sveTrap.bareSveKeyPresent}`);
console.log(`sve2KeyPresent    (FEAT_SVE2)  ${raw.sveTrap.sve2KeyPresent}`);
console.log(`keys containing "SVE" found:   ${raw.sveTrap.keysContainingSve.length}`);
for (const [k, v] of raw.sveTrap.keysContainingSve) {
  console.log(`  ${pad(k, 44)} ${v}`);
}
console.log('');
console.log(raw.sveTrap.trap);

rule('AMX');
console.log(`probed                     ${raw.amx.probed}`);
console.log(`namesFoundInEnumeration    ${JSON.stringify(raw.amx.namesFoundInEnumeration)}`);
console.log('');
console.log(raw.amx.note);
console.log('');
console.log('phantom keys named for documentation and never queried:');
for (const k of raw.phantomKeysNeverQueried) console.log(`  ${k}`);

rule('METAL');
console.log(`metalApi            ${raw.metalApi}`);
console.log(`metalAvailable      ${raw.metalAvailable}`);
console.log(`metalDeviceName     ${JSON.stringify(raw.metalDeviceName)}`);

rule('GPU CORE COUNT (IOKit, measured)');
for (const [k, v] of Object.entries(raw.gpuCoreCount)) {
  console.log(`${pad(k, 14)} ${JSON.stringify(v)}`);
}

rule('RAW KEY SET RETURNED ACROSS FFI');
console.log(Object.keys(raw).join('\n'));
