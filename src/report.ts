/**
 * The human-readable report.
 *
 * This is the highest usability-per-line surface in the package: plenty of
 * people will only ever run the CLI. It therefore prints STATE AND EVIDENCE,
 * never a bare verdict. A line that says `sme  yes` teaches nothing; a line
 * that says `sme  detected  hw.optional.arm.FEAT_SME = 1` teaches the reader
 * where to look next time.
 */
import type { CapabilityDetail } from './registry.js';
import type { Caps } from './snapshot.js';
import { detect } from './snapshot.js';
import type { Evidence, NumericReading } from './state.js';

const WIDTH = 96;

function rule(title: string): string {
  return `\n${title}\n${'-'.repeat(Math.min(WIDTH, Math.max(title.length, 40)))}`;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

/** Wrap prose so a long reason stays readable in a terminal. */
export function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (`${line} ${word}`.length + indent.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

export function describeEvidence(evidence: Evidence, compact = false): string {
  switch (evidence.kind) {
    case 'sysctl':
      return `${evidence.key} = ${evidence.valueText} (${evidence.widthBytes}B)`;
    case 'kernel-declined':
      return compact
        ? `${evidence.key} -> ${evidence.errnoName} (${evidence.errno})`
        : `${evidence.key} -> ${evidence.errnoName} (${evidence.errno}); name is in the MIB, kernel declined for this arch`;
    case 'metal':
      return `${evidence.api} -> ${evidence.deviceName === null ? 'no device' : `"${evidence.deviceName}"`}`;
    case 'ioregistry':
      return `IORegistry ${evidence.matchedClass ?? evidence.ioClass}.${evidence.property}`;
    case 'enumeration-absence':
      return `not among the ${evidence.namesDiscovered} names under ${evidence.root}`;
  }
}

function describeReading(reading: NumericReading): string {
  return reading.state === 'measured'
    ? describeEvidence(reading.evidence)
    : 'not established';
}

function numberLine(label: string, reading: NumericReading, format?: (n: number) => string): string {
  const shown =
    reading.value === null ? 'unknown' : (format?.(reading.value) ?? String(reading.value));
  return `  ${pad(label, 22)} ${pad(shown, 16)} ${describeReading(reading)}`.trimEnd();
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${n} (${(n / 1024 ** 3).toFixed(0)} GiB)`;
  if (n >= 1024 ** 2) return `${n} (${(n / 1024 ** 2).toFixed(0)} MiB)`;
  if (n >= 1024) return `${n} (${(n / 1024).toFixed(0)} KiB)`;
  return String(n);
}

function capabilityLine(cap: CapabilityDetail): string {
  const marker = cap.note !== null ? ' *' : '';
  const evidence =
    cap.state === 'undetectable'
      ? cap.permanent
        ? 'no source exists to consult (permanent)'
        : 'nothing was learned'
      : describeEvidence(cap.evidence, true);
  return `  ${pad(cap.id + marker, 26)} ${pad(cap.state, 14)} ${evidence}`.trimEnd();
}

/** Print the notes behind any `*` markers in a section, once, underneath it. */
function notesFor(caps: readonly CapabilityDetail[]): string[] {
  const out: string[] = [];
  for (const cap of caps) {
    if (cap.note === null) continue;
    out.push(`  * ${cap.id}`);
    out.push(wrap(cap.note, WIDTH, '      '));
  }
  return out;
}

/**
 * Render a full report. Pass a snapshot to render one you already hold;
 * otherwise the memoized snapshot is used.
 */
export function formatReport(snapshot?: Caps): string {
  const caps = snapshot ?? detect();
  const raw = caps.raw();
  const out: string[] = [];

  out.push(`@digitaldefiance/apple-silicon-caps ${caps.packageVersion}`);
  out.push(
    `addon built for ${raw.buildArch} | process ${process.platform}/${process.arch} | node ${process.version}`,
  );
  out.push(`chip: ${caps.chip ?? 'unknown'}`);
  out.push(wrap(caps.chipWarning, WIDTH, '       '));

  out.push(rule('CPU'));
  out.push(numberLine('performance cores', caps.cpu.readings.performanceCores));
  out.push(numberLine('efficiency cores', caps.cpu.readings.efficiencyCores));
  out.push(numberLine('physical cores', caps.cpu.readings.physicalCores));
  out.push(numberLine('logical cores', caps.cpu.readings.logicalCores));

  out.push(rule('CACHE'));
  out.push(numberLine('L1 data', caps.cache.readings.l1d, bytes));
  out.push(numberLine('L1 instruction', caps.cache.readings.l1i, bytes));
  out.push(numberLine('L2', caps.cache.readings.l2, bytes));
  out.push(numberLine('line size', caps.cache.readings.lineSize, bytes));

  out.push(rule('MEMORY'));
  out.push(numberLine('unified memory', caps.memory.readings.bytes, bytes));
  out.push(numberLine('page size', caps.memory.readings.pageSize, bytes));

  out.push(rule('GPU'));
  out.push(numberLine('cores', caps.gpu.readings.cores));
  out.push(
    `  ${pad('metal', 22)} ${pad(String(caps.gpu.metal), 16)} ${describeEvidence({
      kind: 'metal',
      api: raw.metalApi,
      deviceName: caps.gpu.deviceName,
    })}`.trimEnd(),
  );

  out.push(rule('SME'));
  out.push(numberLine('streaming vector bits', caps.sme.svl));
  out.push(`  ${pad('svl bytes', 22)} ${caps.sme.svlBytes ?? 'unknown'}`);
  out.push(`  ${pad('sme', 22)} ${String(caps.sme.available)}`);
  out.push(`  ${pad('sme2', 22)} ${String(caps.sme.sme2)}`);
  out.push(`  ${pad('sme2p1', 22)} ${String(caps.sme.sme2p1)}`);
  out.push('');
  out.push(`  ${pad('DATATYPE', 12)} ${pad('STATE', 14)} SCHEME     KEY`);
  for (const dt of caps.sme.datatypes) {
    out.push(
      `  ${pad(dt.label, 12)} ${pad(dt.state, 14)} ${pad(dt.scheme ?? '-', 10)} ${dt.sysctlKey ?? '-'}`,
    );
  }
  out.push('');
  out.push(wrap(caps.sme.note, WIDTH, '  '));

  const undetectable = caps.all().filter((c) => c.state === 'undetectable');
  out.push(rule(`UNDETECTABLE (${undetectable.length})`));
  out.push(
    wrap(
      'These were not established. That is not the same as absent. Each line says why, ' +
        'and has() reports false for all of them.',
      WIDTH,
      '  ',
    ),
  );
  for (const cap of undetectable) {
    if (cap.state !== 'undetectable') continue;
    out.push('');
    out.push(
      `  ${cap.id}  [undetectable${cap.permanent ? ', permanent' : ''}${cap.probed ? '' : ', never probed'}]`,
    );
    out.push(wrap(cap.reason, WIDTH, '    '));
  }

  const armDetected = caps.all().filter((c) => c.group === 'cpu.arm' && c.state === 'detected');
  const armAbsent = caps.all().filter((c) => c.group === 'cpu.arm' && c.state === 'not-present');
  const other = caps.all().filter((c) => c.group === 'cpu.other');

  out.push(rule(`hw.optional.arm.* DETECTED (${armDetected.length})`));
  for (const cap of armDetected) out.push(capabilityLine(cap));
  out.push(...notesFor(armDetected));

  out.push(rule(`hw.optional.arm.* NOT PRESENT (${armAbsent.length})`));
  out.push(wrap('The key exists and the kernel reported 0. A real answer.', WIDTH, '  '));
  for (const cap of armAbsent) out.push(capabilityLine(cap));

  out.push(rule(`hw.optional.* OUTSIDE THE arm NAMESPACE (${other.length})`));
  out.push(
    wrap(
      'ENOTSUP here means the name IS published in this kernel\'s MIB and the kernel declined ' +
        'to answer for this architecture. That is an answer, so it maps to not-present. ' +
        'Compare ENOENT, where the name is unknown and nothing is learned, which maps to ' +
        'undetectable.',
      WIDTH,
      '  ',
    ),
  );
  for (const cap of other) out.push(capabilityLine(cap));
  out.push(...notesFor(other));

  if (raw.skippedKeys.length > 0) {
    out.push(rule('NAMES DISCOVERED AND DELIBERATELY NOT READ'));
    for (const key of raw.skippedKeys) out.push(`  ${key}`);
  }

  if (raw.armCapsRaw.present) {
    out.push(rule('UNDECODED'));
    out.push(
      `  ${raw.armCapsRaw.key}  ${raw.armCapsRaw.widthBytes}B  ${raw.armCapsRaw.hex}`,
    );
    out.push(wrap(raw.armCapsRaw.note, WIDTH, '    '));
  }

  out.push(rule('HOW TO READ THIS'));
  out.push(
    wrap(
      'detected: a source was consulted and said yes. not-present: a source was consulted ' +
        'and said no. undetectable: nothing was learned, and the reason says why. ' +
        'caps.has(id) is true only for detected, so treat false as "not established" and ' +
        'call caps.detail(id) when the difference matters.',
      WIDTH,
      '  ',
    ),
  );

  return out.join('\n');
}
