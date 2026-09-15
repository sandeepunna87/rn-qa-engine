import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EngineConfig } from '../types';

/**
 * WHY THIS FILE EXISTS
 *
 * The first version of the verify loop required `tsc --noEmit` to be clean and
 * the entire existing jest suite to be green. On the toy fixture that was true.
 * On a real repo it is almost never true — most codebases carry pre-existing
 * type errors and a handful of failing or flaky tests.
 *
 * With absolute gates, every single generation gets rejected for a failure it
 * did not cause, forever, and the engine looks broken on day one.
 *
 * So the gates are DIFFERENTIAL: capture the repo's existing failures once, up
 * front, and fail a generation only for failures it actually introduced.
 */

export interface Baseline {
  tscErrors: Set<string>;
  failingTests: Set<string>;
  tscAvailable: boolean;
  jestAvailable: boolean;
  notes: string[];
}

/** file + rule + message, deliberately WITHOUT the line number — lines shift. */
function tscSignature(line: string): string | null {
  const m = /^(.+?)\((\d+),(\d+)\):\s+(error\s+TS\d+):\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  return `${m[1]}|${m[4]}|${m[5]}`;
}

export function captureTscBaseline(cwd: string): { errors: Set<string>; available: boolean } {
  if (!fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return { errors: new Set(), available: false };
  }
  try {
    execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { errors: new Set(), available: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    const errors = new Set<string>();
    for (const line of out.split('\n')) {
      const sig = tscSignature(line);
      if (sig) errors.add(sig);
    }
    // No parseable diagnostics but a non-zero exit means tsc itself failed to
    // run (missing tsconfig include, bad extends). Treat as unavailable rather
    // than silently baselining zero errors.
    return { errors, available: errors.size > 0 };
  }
}

export function parseTscErrors(output: string): Set<string> {
  const out = new Set<string>();
  for (const line of output.split('\n')) {
    const sig = tscSignature(line);
    if (sig) out.add(sig);
  }
  return out;
}

interface JestJsonResult {
  testResults?: {
    name: string;
    assertionResults?: { fullName: string; title: string; status: string }[];
  }[];
}

/** "<test file>::<full test name>" for every test not passing. */
export function parseJestFailures(jsonText: string): Set<string> {
  const out = new Set<string>();
  try {
    const parsed = JSON.parse(jsonText) as JestJsonResult;
    for (const f of parsed.testResults ?? []) {
      for (const a of f.assertionResults ?? []) {
        if (a.status === 'failed') out.add(`${path.basename(f.name)}::${a.fullName || a.title}`);
      }
    }
  } catch {
    /* unparseable — caller decides what to do */
  }
  return out;
}

export function captureJestBaseline(
  config: EngineConfig,
  cwd: string
): { failures: Set<string>; available: boolean } {
  const [bin, ...baseArgs] = config.jest.command.split(/\s+/);
  const jsonPath = path.join(cwd, '.rnqa', 'jest-baseline.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  const args = [...baseArgs, '--ci', '--silent', '--json', `--outputFile=${jsonPath}`];
  if (config.jest.configPath) args.push(`--config=${config.jest.configPath}`);

  try {
    execFileSync(bin, args, {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, CI: 'true' },
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    /* non-zero exit is expected when tests fail — the JSON is still written */
  }

  if (!fs.existsSync(jsonPath)) return { failures: new Set(), available: false };
  return { failures: parseJestFailures(fs.readFileSync(jsonPath, 'utf8')), available: true };
}

export function captureBaseline(config: EngineConfig): Baseline {
  const notes: string[] = [];
  const tsc = captureTscBaseline(config.projectRoot);
  const jest = captureJestBaseline(config, config.projectRoot);

  if (!tsc.available) {
    notes.push('tsc did not produce parseable diagnostics — the typecheck gate will be SKIPPED.');
  } else if (tsc.errors.size > 0) {
    notes.push(
      `${tsc.errors.size} pre-existing type error(s) baselined — the gate will only fail on NEW ones.`
    );
  }
  if (!jest.available) {
    notes.push('jest --json produced no report — the no-regression gate will be SKIPPED.');
  } else if (jest.failures.size > 0) {
    notes.push(
      `${jest.failures.size} already-failing test(s) baselined — the gate will only fail on NEW failures.`
    );
  }

  return {
    tscErrors: tsc.errors,
    failingTests: jest.failures,
    tscAvailable: tsc.available,
    jestAvailable: jest.available,
    notes,
  };
}

export const EMPTY_BASELINE: Baseline = {
  tscErrors: new Set(),
  failingTests: new Set(),
  tscAvailable: true,
  jestAvailable: true,
  notes: [],
};
