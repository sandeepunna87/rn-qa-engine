import * as fs from 'fs';
import * as path from 'path';
import { FileCoverage } from '../types';

/**
 * Ingests an existing lcov.info instead of re-running jest.
 *
 * Why this exists: a repo large enough to shard its test run (8 shards, merged
 * lcov, uploaded to SonarQube) cannot afford the engine doing a second, single
 * -process `jest --coverage` over everything just to rank files. That run is
 * the most expensive thing the engine does and the answer already exists.
 *
 * lcov carries everything triage needs:
 *   DA:line,hits          -> uncovered lines
 *   BRDA:line,blk,br,taken-> uncovered branch ARMS ('-' or 0 = never taken)
 *   FN / FNDA             -> never-invoked functions, by name
 *
 * What it does not carry is istanbul's statementMap, so `statements` is
 * approximated by line coverage. Triage ranks on branches, so this does not
 * affect the ordering.
 */
export function parseLcov(lcovPath: string, projectRoot: string): Map<string, FileCoverage> {
  const text = fs.readFileSync(lcovPath, 'utf8');
  const out = new Map<string, FileCoverage>();

  let file: string | null = null;
  let lineHits: Map<number, number> = new Map();
  let branchArms: { line: number; taken: boolean }[] = [];
  let fnNames: Map<string, number> = new Map();

  const flush = (): void => {
    if (!file) return;
    const abs = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

    const uncoveredLines: number[] = [];
    let linesCovered = 0;
    for (const [line, hits] of lineHits) {
      if (hits > 0) linesCovered++;
      else uncoveredLines.push(line);
    }

    const uncoveredBranchLines = new Set<number>();
    let branchesCovered = 0;
    for (const arm of branchArms) {
      if (arm.taken) branchesCovered++;
      else uncoveredBranchLines.add(arm.line);
    }

    const uncoveredFunctions: string[] = [];
    let fnCovered = 0;
    for (const [name, hits] of fnNames) {
      if (hits > 0) fnCovered++;
      else uncoveredFunctions.push(name);
    }

    out.set(abs, {
      path: abs,
      // lcov has no statement map; line coverage is the closest honest proxy.
      statements: { covered: linesCovered, total: lineHits.size },
      branches: { covered: branchesCovered, total: branchArms.length },
      functions: { covered: fnCovered, total: fnNames.size },
      uncoveredLines: uncoveredLines.sort((a, b) => a - b),
      uncoveredBranchLines: [...uncoveredBranchLines].sort((a, b) => a - b),
      uncoveredFunctions,
    });

    file = null;
    lineHits = new Map();
    branchArms = [];
    fnNames = new Map();
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('SF:')) {
      flush();
      file = line.slice(3);
    } else if (line.startsWith('DA:')) {
      const [l, h] = line.slice(3).split(',');
      lineHits.set(parseInt(l, 10), parseInt(h, 10) || 0);
    } else if (line.startsWith('BRDA:')) {
      // BRDA:<line>,<block>,<branch>,<taken>  — taken is a count or '-'
      const parts = line.slice(5).split(',');
      const ln = parseInt(parts[0], 10);
      const takenRaw = parts[3];
      const taken = takenRaw !== '-' && parseInt(takenRaw, 10) > 0;
      branchArms.push({ line: ln, taken });
    } else if (line.startsWith('FN:')) {
      // FN:<line>,<name>  — name may itself contain commas, so split once.
      const rest = line.slice(3);
      const comma = rest.indexOf(',');
      if (comma !== -1) {
        const name = rest.slice(comma + 1);
        if (!fnNames.has(name)) fnNames.set(name, 0);
      }
    } else if (line.startsWith('FNDA:')) {
      const rest = line.slice(5);
      const comma = rest.indexOf(',');
      if (comma !== -1) {
        const hits = parseInt(rest.slice(0, comma), 10) || 0;
        const name = rest.slice(comma + 1);
        fnNames.set(name, Math.max(fnNames.get(name) ?? 0, hits));
      }
    } else if (line === 'end_of_record') {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Merges several lcov files — one per shard — by summing hit counts.
 * Use when the shards are NOT already merged before the Sonar upload.
 */
export function parseLcovShards(
  lcovPaths: string[],
  projectRoot: string
): Map<string, FileCoverage> {
  if (lcovPaths.length === 1) return parseLcov(lcovPaths[0], projectRoot);

  const merged = new Map<string, FileCoverage>();
  for (const p of lcovPaths) {
    for (const [abs, cov] of parseLcov(p, projectRoot)) {
      const existing = merged.get(abs);
      if (!existing) {
        merged.set(abs, cov);
        continue;
      }
      // A line/arm covered in ANY shard is covered overall.
      const uncoveredLines = existing.uncoveredLines.filter((l) => cov.uncoveredLines.includes(l));
      const uncoveredBranchLines = existing.uncoveredBranchLines.filter((l) =>
        cov.uncoveredBranchLines.includes(l)
      );
      const uncoveredFunctions = existing.uncoveredFunctions.filter((f) =>
        cov.uncoveredFunctions.includes(f)
      );
      merged.set(abs, {
        path: abs,
        statements: {
          covered: existing.statements.total - uncoveredLines.length,
          total: existing.statements.total,
        },
        branches: {
          covered: existing.branches.total - uncoveredBranchLines.length,
          total: existing.branches.total,
        },
        functions: {
          covered: existing.functions.total - uncoveredFunctions.length,
          total: existing.functions.total,
        },
        uncoveredLines,
        uncoveredBranchLines,
        uncoveredFunctions,
      });
    }
  }
  return merged;
}

/** Expand a comma-separated list and/or a glob-ish shard pattern. */
export function resolveLcovPaths(projectRoot: string, spec: string): string[] {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const abs = path.isAbsolute(part) ? part : path.resolve(projectRoot, part);
    if (abs.includes('*')) {
      // Only a trailing "<dir>/*/lcov.info" style pattern is supported.
      const [dir, ...rest] = abs.split('*');
      const tail = rest.join('*').replace(/^[\\/]+/, '');
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          const candidate = path.join(dir, entry, tail);
          if (fs.existsSync(candidate)) out.push(candidate);
        }
      }
    } else if (fs.existsSync(abs)) {
      out.push(abs);
    }
  }
  return out;
}
