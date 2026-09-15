import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { branchPct, statementPct } from './signal/coverage';
import {
  EngineConfig,
  FileCoverage,
  FileFacts,
  SonarIssue,
  Task,
  TaskKind,
  Tier,
} from './types';

/** 90-day churn per file. High-churn + low-coverage is where bugs actually ship. */
export function gitChurn(projectRoot: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const out = execFileSync(
      'git',
      ['log', '--since=90.days', '--pretty=format:', '--name-only'],
      { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    for (const line of out.split('\n')) {
      const rel = line.trim();
      if (!rel) continue;
      const abs = path.resolve(projectRoot, rel);
      map.set(abs, (map.get(abs) ?? 0) + 1);
    }
  } catch {
    // Not a git repo, or git unavailable. Churn simply drops out of the score.
  }
  return map;
}

function isSensitive(config: EngineConfig, absPath: string): string | null {
  const lower = absPath.toLowerCase();
  return config.sensitivePathPatterns.find((p) => lower.includes(p)) ?? null;
}

export function findExistingTest(config: EngineConfig, absPath: string): string | null {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath).replace(/\.(tsx?|jsx?)$/, '');
  const ext = absPath.endsWith('.tsx') ? 'tsx' : 'ts';
  const candidates = [
    path.join(dir, `${base}.test.${ext}`),
    path.join(dir, `${base}.spec.${ext}`),
    path.join(dir, config.testGlob, `${base}.test.${ext}`),
    path.join(dir, config.testGlob, `${base}.spec.${ext}`),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function testPathFor(config: EngineConfig, absPath: string): string {
  const existing = findExistingTest(config, absPath);
  if (existing) return existing;
  const dir = path.dirname(absPath);
  const base = path.basename(absPath).replace(/\.(tsx?|jsx?)$/, '');
  const ext = absPath.endsWith('.tsx') ? 'tsx' : 'ts';
  return path.join(dir, config.testGlob, `${base}.test.${ext}`);
}

/**
 * Tier is assigned before the model is ever called. This is the control that
 * keeps an LLM away from code where a plausible-looking wrong answer is
 * expensive — the engine's credibility depends on it never guessing here.
 */
function assignTier(
  config: EngineConfig,
  kind: TaskKind,
  absPath: string,
  issues: SonarIssue[]
): { tier: Tier; reason: string } {
  const sensitive = isSensitive(config, absPath);
  if (sensitive) {
    return { tier: 'C', reason: `Sensitive path (matched "${sensitive}") — advisory only, no edits.` };
  }
  if (issues.some((i) => i.type === 'VULNERABILITY')) {
    return { tier: 'C', reason: 'Sonar VULNERABILITY present — advisory only.' };
  }
  if (kind === 'sonar-fix') {
    const allAllowlisted = issues.every((i) => config.sonar.autoFixRules.includes(i.rule));
    return allAllowlisted
      ? { tier: 'A', reason: 'All issues are on the deterministic auto-fix allowlist.' }
      : { tier: 'B', reason: 'Contains rules outside the auto-fix allowlist — human review required.' };
  }
  return { tier: 'B', reason: 'Generated code requires human review before merge.' };
}

export interface TriageInput {
  config: EngineConfig;
  candidates: string[]; // absolute paths
  coverage: Map<string, FileCoverage>;
  issuesByPath: Map<string, SonarIssue[]>;
  factsFor: (absPath: string) => FileFacts;
}

/**
 * Score = risk-weighted opportunity. Deliberately transparent arithmetic:
 * a developer who disagrees with the ranking must be able to see exactly why.
 */
export function triage(input: TriageInput): Task[] {
  const { config, candidates, coverage, issuesByPath, factsFor } = input;
  const churn = gitChurn(config.projectRoot);
  const tasks: Task[] = [];

  for (const abs of candidates) {
    const cov = coverage.get(abs) ?? null;
    const issues = issuesByPath.get(abs) ?? [];

    let facts: FileFacts;
    try {
      facts = factsFor(abs);
    } catch {
      continue; // Unparseable file — skip rather than feed garbage to the model.
    }

    const bPct = branchPct(cov);
    const sPct = statementPct(cov);
    const maxComplexity = Math.max(0, ...Object.values(facts.complexityByExport));
    const churnCount = churn.get(abs) ?? 0;

    // --- Test generation task -------------------------------------------------
    const uncoveredBranches = cov ? cov.branches.total - cov.branches.covered : 0;
    if (uncoveredBranches > 0 || (cov === null && facts.exports.length > 0)) {
      const coverageGap = 100 - bPct; // 0..100
      const complexityFactor = Math.min(maxComplexity / 15, 2); // caps at 2x
      const churnFactor = 1 + Math.min(churnCount / 10, 1); // 1..2x
      const score = coverageGap * (1 + complexityFactor) * churnFactor;

      const { tier, reason } = assignTier(config, 'test-generation', abs, issues);
      const rationale = [
        `Branch coverage ${bPct.toFixed(0)}% (${cov?.branches.covered ?? 0}/${cov?.branches.total ?? 0}), statements ${sPct.toFixed(0)}%.`,
        `${uncoveredBranches} untested branch arm(s); ${cov?.uncoveredFunctions.length ?? 0} never-invoked function(s).`,
        `Peak cognitive complexity ${maxComplexity}.`,
        churnCount > 0 ? `Changed in ${churnCount} commit(s) in the last 90 days.` : 'No recent churn.',
        reason,
      ];

      tasks.push({
        id: `test:${path.relative(config.projectRoot, abs)}`,
        kind: 'test-generation',
        tier,
        targetPath: abs,
        existingTestPath: findExistingTest(config, abs),
        coverage: cov,
        sonarIssues: issues,
        facts,
        score,
        rationale,
      });
    }

    // --- Sonar fix task -------------------------------------------------------
    if (issues.length > 0) {
      const severityWeight: Record<SonarIssue['severity'], number> = {
        INFO: 1,
        MINOR: 2,
        MAJOR: 5,
        CRITICAL: 10,
        BLOCKER: 20,
      };
      const score = issues.reduce((sum, i) => sum + severityWeight[i.severity], 0) * 3;
      const { tier, reason } = assignTier(config, 'sonar-fix', abs, issues);
      tasks.push({
        id: `sonar:${path.relative(config.projectRoot, abs)}`,
        kind: 'sonar-fix',
        tier,
        targetPath: abs,
        existingTestPath: findExistingTest(config, abs),
        coverage: cov,
        sonarIssues: issues,
        facts,
        score,
        rationale: [
          `${issues.length} open Sonar issue(s): ${[...new Set(issues.map((i) => i.rule))].join(', ')}.`,
          reason,
        ],
      });
    }
  }

  return tasks.sort((a, b) => b.score - a.score);
}

/** Tier C never reaches the model. Enforced here, not in the prompt. */
export function selectExecutable(tasks: Task[], maxTasks: number): {
  executable: Task[];
  advisory: Task[];
} {
  const advisory = tasks.filter((t) => t.tier === 'C');
  const executable = tasks.filter((t) => t.tier !== 'C').slice(0, maxTasks);
  return { executable, advisory };
}
