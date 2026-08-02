#!/usr/bin/env node
/**
 * The CLI.
 *
 * `npx @digitaldefiance/apple-silicon-caps` prints a report with state AND
 * evidence for everything this machine will admit to. For many users this is the
 * only part of the package they will ever touch, so it is treated as a first
 * class surface rather than a debug dump.
 *
 * The addon is imported LAZILY, after argument parsing, so `--help` still works
 * on a broken install. Everything else deliberately fails loudly instead.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CapsError } from './errors.js';

const USAGE = `apple-silicon-caps - honest Apple Silicon capability detection

USAGE
  apple-silicon-caps [options]

OPTIONS
  (none)              human-readable report: state AND evidence for everything
  --json              machine-readable report, stable shape, for scripting
  --raw               the untouched native payload, for bug reports
  --check <cap>       exit 0 if the capability is DETECTED, 1 otherwise
  --digest            print only the canonical snapshot digest
  -h, --help          this text

EXIT CODES
  0  success, or --check found a detected capability
  1  --check found a capability that is not-present or undetectable
  2  usage error, unknown capability, or detection failed

NOTES
  "not-present" means a source was consulted and said no.
  "undetectable" means nothing was learned; the reason is printed.
  --check treats undetectable as failure, because it has not been established.

EXAMPLES
  apple-silicon-caps
  apple-silicon-caps --json | jq '.capabilities.sme'
  apple-silicon-caps --check sme && echo "streaming matrix path available"
`;

interface Args {
  mode: 'report' | 'json' | 'raw' | 'check' | 'digest' | 'help';
  capability?: string;
  error?: string;
}

export function parseArgs(argv: readonly string[]): Args {
  if (argv.length === 0) return { mode: 'report' };

  const [first, ...rest] = argv;
  switch (first) {
    case '-h':
    case '--help':
      return { mode: 'help' };
    case '--json':
      return { mode: 'json' };
    case '--raw':
      return { mode: 'raw' };
    case '--digest':
      return { mode: 'digest' };
    case '--check': {
      const cap = rest[0];
      if (cap === undefined || cap.startsWith('-')) {
        return { mode: 'help', error: '--check requires a capability name, e.g. --check sme' };
      }
      return { mode: 'check', capability: cap };
    }
    default:
      return { mode: 'help', error: `Unknown option '${first ?? ''}'` };
  }
}

/** The `--json` shape. Stable: fields may be added, never removed or renamed. */
function jsonReport(
  caps: import('./snapshot.js').Caps,
  canonical: import('./snapshot.js').CanonicalSnapshot,
): unknown {
  return {
    schemaVersion: caps.schemaVersion,
    packageVersion: caps.packageVersion,
    chip: { value: caps.chip, informationalOnly: true, warning: caps.chipWarning },
    host: {
      buildArch: caps.cpu.buildArch,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    cpu: {
      performanceCores: caps.cpu.performanceCores,
      efficiencyCores: caps.cpu.efficiencyCores,
      physicalCores: caps.cpu.physicalCores,
      logicalCores: caps.cpu.logicalCores,
      readings: caps.cpu.readings,
    },
    cache: {
      l1d: caps.cache.l1d,
      l1i: caps.cache.l1i,
      l2: caps.cache.l2,
      lineSize: caps.cache.lineSize,
      readings: caps.cache.readings,
    },
    memory: {
      bytes: caps.memory.bytes,
      pageSize: caps.memory.pageSize,
      readings: caps.memory.readings,
    },
    gpu: {
      cores: caps.gpu.cores,
      metal: caps.gpu.metal,
      deviceName: caps.gpu.deviceName,
      readings: caps.gpu.readings,
    },
    sme: {
      available: caps.sme.available,
      sme2: caps.sme.sme2,
      sme2p1: caps.sme.sme2p1,
      svlBits: caps.sme.svlBits,
      svlBytes: caps.sme.svlBytes,
      svl: caps.sme.svl,
      datatypes: caps.sme.datatypes,
      note: caps.sme.note,
    },
    capabilities: Object.fromEntries(caps.all().map((c) => [c.id, c])),
    canonical,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.mode === 'help') {
    if (args.error !== undefined) {
      process.stderr.write(`${args.error}\n\n${USAGE}`);
      return 2;
    }
    process.stdout.write(USAGE);
    return 0;
  }

  // Imported here, not at module scope: --help must survive a broken addon.
  const { detect, canonicalSnapshot } = await import('./snapshot.js');
  const { formatReport } = await import('./report.js');

  const caps = detect();

  switch (args.mode) {
    case 'report':
      process.stdout.write(`${formatReport(caps)}\n`);
      return 0;

    case 'json':
      process.stdout.write(`${JSON.stringify(jsonReport(caps, canonicalSnapshot()), null, 2)}\n`);
      return 0;

    case 'raw':
      process.stdout.write(`${JSON.stringify(caps.raw(), null, 2)}\n`);
      return 0;

    case 'digest':
      process.stdout.write(`${canonicalSnapshot().digest}\n`);
      return 0;

    case 'check': {
      const name = args.capability ?? '';
      let detail;
      try {
        detail = caps.detail(name);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      if (detail.state === 'detected') {
        process.stdout.write(`${detail.id} detected\n`);
        return 0;
      }
      if (detail.state === 'undetectable') {
        // First sentence only. --check is for CI logs, and the full reason is
        // several hundred words; it is one `apple-silicon-caps` away.
        const firstSentence = /^.*?\.(?=\s|$)/.exec(detail.reason)?.[0] ?? detail.reason;
        process.stderr.write(
          `${detail.id} undetectable${detail.permanent ? ' (permanent)' : ''}: ` +
            `${firstSentence} (run without --check for the full reason)\n`,
        );
        return 1;
      }
      process.stderr.write(`${detail.id} not-present\n`);
      return 1;
    }
  }
}

/**
 * True when this file is the program, false when it is imported by a test.
 * `realpathSync` matters: npm installs the bin as a symlink under
 * node_modules/.bin, so argv[1] is not the file path until it is resolved.
 */
function directRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

const isDirectRun = directRun();

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (err instanceof CapsError) {
        process.stderr.write(`${err.name} [${err.code}]: ${err.message}\n`);
      } else {
        process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      }
      process.exitCode = 2;
    });
}
