import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EngineConfig, FileCoverage } from '../types';

interface IstanbulLoc {
  start: { line: number; column: number | null };
  end: { line: number; column: number | null };
}

interface IstanbulFileEntry {
  path: string;
  statementMap: Record<string, IstanbulLoc>;
  fnMap: Record<string, { name: string; decl: IstanbulLoc; loc: IstanbulLoc }>;
  branchMap: Record<string, { loc: IstanbulLoc; type: string; locations: IstanbulLoc[] }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

/**
 * Runs the project's own jest with coverage into a scratch dir and returns the
 * raw istanbul map. We deliberately shell out to the project's jest rather than
 * embedding one, so the engine inherits the repo's transforms, moduleNameMapper
 * and RN preset — the single biggest source of "generated test won't even run".
 */
export function runCoverage(
  config: EngineConfig,
  opts: {
    cwd?: string;
    outDir: string;
    testPathPattern?: string;
    silent?: boolean;
    /** Restrict instrumentation to these globs — makes a scoped run cheap. */
    collectCoverageFrom?: string[];
    /** Run only the tests related to these files. */
    findRelatedTests?: string[];
  } = { outDir: '' }
): Record<string, IstanbulFileEntry> {
  const cwd = opts.cwd ?? config.projectRoot;
  const outDir = opts.outDir || path.join(cwd, '.rnqa', 'coverage');
  fs.mkdirSync(outDir, { recursive: true });

  const [bin, ...baseArgs] = config.jest.command.split(/\s+/);
  const args = [
    ...baseArgs,
    '--coverage',
    '--coverageReporters=json',
    `--coverageDirectory=${outDir}`,
    '--ci',
    '--silent',
    '--passWithNoTests',
  ];
  if (config.jest.configPath) args.push(`--config=${config.jest.configPath}`);
  if (config.jest.maxWorkers) args.push(`--maxWorkers=${config.jest.maxWorkers}`);
  for (const g of opts.collectCoverageFrom ?? []) args.push(`--collectCoverageFrom=${g}`);
  // --findRelatedTests takes the paths as positional args and must come last.
  if (opts.findRelatedTests?.length) args.push('--findRelatedTests', ...opts.findRelatedTests);
  if (opts.testPathPattern) args.push(`--testPathPattern=${opts.testPathPattern}`);

  try {
    execFileSync(bin, args, {
      cwd,
      stdio: opts.silent ? 'ignore' : 'inherit',
      env: { ...process.env, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // Non-zero exit means some tests failed. Coverage JSON is still written,
    // and we want it: a repo with failing tests is exactly the one being triaged.
  }

  const jsonPath = path.join(outDir, 'coverage-final.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `No coverage-final.json at ${jsonPath}. Check that "${config.jest.command}" runs from ${cwd}.`
    );
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, IstanbulFileEntry>;
}

/** Reduce one istanbul entry to the facts triage and the prompt need. */
export function summariseFile(entry: IstanbulFileEntry): FileCoverage {
  const uncoveredLines = new Set<number>();
  let sCovered = 0;
  const sTotal = Object.keys(entry.statementMap).length;
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    const hits = entry.s[id] ?? 0;
    if (hits > 0) sCovered++;
    else for (let l = loc.start.line; l <= loc.end.line; l++) uncoveredLines.add(l);
  }

  const uncoveredBranchLines = new Set<number>();
  let bCovered = 0;
  let bTotal = 0;
  for (const [id, meta] of Object.entries(entry.branchMap)) {
    const arms = entry.b[id] ?? [];
    for (let i = 0; i < arms.length; i++) {
      bTotal++;
      if (arms[i] > 0) bCovered++;
      // Record the specific arm's line, not the whole branch — a partially
      // covered ternary should point the model at the untaken side.
      else uncoveredBranchLines.add(meta.locations[i]?.start.line ?? meta.loc.start.line);
    }
  }

  const uncoveredFunctions: string[] = [];
  let fCovered = 0;
  const fTotal = Object.keys(entry.fnMap).length;
  for (const [id, meta] of Object.entries(entry.fnMap)) {
    if ((entry.f[id] ?? 0) > 0) fCovered++;
    else uncoveredFunctions.push(meta.name || `anonymous@${meta.loc.start.line}`);
  }

  return {
    path: entry.path,
    statements: { covered: sCovered, total: sTotal },
    branches: { covered: bCovered, total: bTotal },
    functions: { covered: fCovered, total: fTotal },
    uncoveredLines: [...uncoveredLines].sort((a, b) => a - b),
    uncoveredBranchLines: [...uncoveredBranchLines].sort((a, b) => a - b),
    uncoveredFunctions,
  };
}

export function summariseAll(
  raw: Record<string, IstanbulFileEntry>
): Map<string, FileCoverage> {
  const map = new Map<string, FileCoverage>();
  for (const entry of Object.values(raw)) {
    map.set(path.resolve(entry.path), summariseFile(entry));
  }
  return map;
}

export function branchPct(c: FileCoverage | null): number {
  if (!c || c.branches.total === 0) return 100;
  return (c.branches.covered / c.branches.total) * 100;
}

export function statementPct(c: FileCoverage | null): number {
  if (!c || c.statements.total === 0) return 100;
  return (c.statements.covered / c.statements.total) * 100;
}
