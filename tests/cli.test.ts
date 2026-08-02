/**
 * The CLI.
 *
 * `main()` is called in-process and its exit code is the assertion, so the tests
 * do not depend on a build step or on a shell. Stdout is captured rather than
 * printed so the suite output stays readable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parseArgs } from '../src/cli.js';

function capture(): { out: () => string; err: () => string; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('defaults to the human report', () => {
    expect(parseArgs([])).toStrictEqual({ mode: 'report' });
  });

  it('recognises every documented flag', () => {
    expect(parseArgs(['--json']).mode).toBe('json');
    expect(parseArgs(['--raw']).mode).toBe('raw');
    expect(parseArgs(['--digest']).mode).toBe('digest');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(parseArgs(['-h']).mode).toBe('help');
    expect(parseArgs(['--check', 'sme'])).toStrictEqual({ mode: 'check', capability: 'sme' });
  });

  it('rejects --check with no capability, and unknown flags', () => {
    expect(parseArgs(['--check']).error).toMatch(/requires a capability/);
    expect(parseArgs(['--check', '--json']).error).toMatch(/requires a capability/);
    expect(parseArgs(['--nope']).error).toMatch(/Unknown option/);
  });
});

describe('main', () => {
  it('prints the report and exits 0', async () => {
    const io = capture();
    try {
      expect(await main([])).toBe(0);
      expect(io.out()).toContain('UNDETECTABLE');
      expect(io.out()).toContain('HOW TO READ THIS');
    } finally {
      io.restore();
    }
  });

  it('--json emits parseable output with a stable shape', async () => {
    const io = capture();
    try {
      expect(await main(['--json'])).toBe(0);
      const parsed = JSON.parse(io.out()) as Record<string, unknown>;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed).toHaveProperty('capabilities');
      expect(parsed).toHaveProperty('canonical');
      const capabilities = parsed.capabilities as Record<string, { state: string }>;
      expect(capabilities.amx?.state).toBe('undetectable');
      expect(capabilities.sme?.state).toBe('detected');
      expect((parsed.chip as { informationalOnly: boolean }).informationalOnly).toBe(true);
    } finally {
      io.restore();
    }
  });

  it('--raw emits the native payload', async () => {
    const io = capture();
    try {
      expect(await main(['--raw'])).toBe(0);
      const parsed = JSON.parse(io.out()) as Record<string, unknown>;
      expect(parsed).toHaveProperty('enumerated');
      expect(parsed).toHaveProperty('namedProbes');
      expect(parsed.enumerationOk).toBe(true);
    } finally {
      io.restore();
    }
  });

  it('--check exits 0 for detected, 1 for not established, 2 for unknown', async () => {
    const io = capture();
    try {
      expect(await main(['--check', 'sme'])).toBe(0);
      // undetectable: not established, so a shell script must not proceed.
      expect(await main(['--check', 'amx'])).toBe(1);
      // not-present: a real answer, and still a failure for --check.
      expect(await main(['--check', 'mte'])).toBe(1);
      expect(await main(['--check', 'nonsense-capability'])).toBe(2);
      expect(io.err()).toMatch(/amx undetectable \(permanent\)/);
    } finally {
      io.restore();
    }
  });

  it('--help works and does not require detection to have succeeded', async () => {
    const io = capture();
    try {
      expect(await main(['--help'])).toBe(0);
      expect(io.out()).toContain('--check <cap>');
      expect(io.out()).toMatch(/undetectable.*nothing was learned/s);
    } finally {
      io.restore();
    }
  });

  it('a usage error goes to stderr and exits 2', async () => {
    const io = capture();
    try {
      expect(await main(['--wat'])).toBe(2);
      expect(io.err()).toMatch(/Unknown option/);
    } finally {
      io.restore();
    }
  });
});
