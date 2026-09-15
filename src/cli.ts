#!/usr/bin/env node
import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from './config';
import { createProject, extractFacts } from './context/facts';
import { detectConventions } from './context/conventions';
import { findCandidates } from './context/walk';
import { createProvider, parseGeneration } from './generate/provider';
import {
  SYSTEM_PROMPT,
  buildRetryPrompt,
  buildSonarFixPrompt,
  buildTestPrompt,
} from './generate/prompts';
import { RunRecord, renderReport } from './report/html';
import { runCoverage, summariseAll, branchPct } from './signal/coverage';
import { parseLcovShards, resolveLcovPaths } from './signal/lcov';
import { findChangedFiles } from './signal/changed';
import { fetchSonarIssues, groupIssuesByPath } from './signal/sonar';
import { selectExecutable, triage } from './triage';
import { Baseline, captureBaseline, captureJestBaseline, captureTscBaseline } from './verify/baseline';
import { verify } from './verify/runner';
import { EngineConfig, FileCoverage, ProviderMessage, SonarIssue, Task } from './types';

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

async function collectSignals(
  config: EngineConfig,
  opts: { skipCoverage: boolean; pullRequest?: string; branch?: string }
): Promise<{ coverage: Map<string, FileCoverage>; issues: SonarIssue[] }> {
  let coverage = new Map<string, FileCoverage>();
  if (!opts.skipCoverage) {
    if (config.coverage.source === 'lcov') {
      const spec = config.coverage.lcovPath;
      if (!spec) throw new Error('coverage.source is "lcov" but coverage.lcovPath is not set.');
      const paths = resolveLcovPaths(config.projectRoot, spec);
      if (paths.length === 0) {
        throw new Error(
          `No lcov file found for "${spec}". Run your normal sharded test job first, then point coverage.lcovPath at the merged lcov.info.`
        );
      }
      log(`▸ reading coverage from ${paths.length} lcov file(s) — no jest run needed`);
      coverage = parseLcovShards(paths, config.projectRoot);
      log(`  ${coverage.size} file(s) in the report`);
    } else {
      log('▸ running jest --coverage (baseline)…');
      coverage = summariseAll(
        runCoverage(config, { outDir: path.join(config.projectRoot, '.rnqa', 'coverage-base'), silent: true })
      );
      log(`  ${coverage.size} file(s) instrumented`);
    }
  }

  let issues: SonarIssue[] = [];
  if (config.sonar.enabled) {
    log('▸ fetching SonarQube issues…');
    issues = await fetchSonarIssues(config, { pullRequest: opts.pullRequest, branch: opts.branch });
    log(`  ${issues.length} open issue(s)`);
  }
  return { coverage, issues };
}

function buildTasks(
  config: EngineConfig,
  coverage: Map<string, FileCoverage>,
  issues: SonarIssue[],
  only?: string,
  restrictTo?: string[]
): Task[] {
  let candidates = findCandidates(config.projectRoot, config.include, config.exclude);
  if (restrictTo) {
    const allowed = new Set(restrictTo);
    candidates = candidates.filter((c) => allowed.has(c));
  }
  if (only) {
    const abs = path.resolve(config.projectRoot, only);
    candidates = candidates.filter((c) => c === abs || c.includes(only));
  }
  log(`▸ ${candidates.length} source file(s) in scope`);

  const project = createProject(config.projectRoot);
  const factsCache = new Map<string, ReturnType<typeof extractFacts>>();

  return triage({
    config,
    candidates,
    coverage,
    issuesByPath: groupIssuesByPath(issues),
    factsFor: (abs) => {
      const hit = factsCache.get(abs);
      if (hit) return hit;
      const f = extractFacts(project, abs);
      factsCache.set(abs, f);
      return f;
    },
  });
}


/** The generate → verify → retry loop, shared by `run` and `feature`. */
async function runTasks(
  config: EngineConfig,
  provider: ReturnType<typeof createProvider>,
  tasks: Task[],
  coverage: Map<string, FileCoverage>,
  baseline: Baseline,
  apply: boolean
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];

  for (const task of tasks) {
    log(`\n── ${task.id} [tier ${task.tier}] ─────────────`);
    const firstPrompt =
      task.kind === 'test-generation'
        ? buildTestPrompt(config, task)
        : buildSonarFixPrompt(config, task);

    const messages: ProviderMessage[] = [{ role: 'user', content: firstPrompt }];
    const record: RunRecord = { task, generation: null, result: null, attempts: 0, diff: '' };

    for (let attempt = 1; attempt <= config.gates.maxAttempts; attempt++) {
      record.attempts = attempt;
      log(`  attempt ${attempt}/${config.gates.maxAttempts} — generating…`);

      let raw: string;
      try {
        raw = await provider.complete({
          system: SYSTEM_PROMPT,
          messages,
          maxTokens: 8000,
          temperature: attempt === 1 ? 0.1 : 0.3,
        });
      } catch (err) {
        record.error = `Provider error: ${(err as Error).message}`;
        log(`  ✕ ${record.error}`);
        break;
      }

      const gen = parseGeneration(task.id, raw);
      record.generation = gen;

      const { result, sandbox } = await verify(config, task, gen, attempt, coverage, baseline);
      record.result = result;
      for (const g of result.gates) {
        log(`    ${g.passed ? '✓' : '✕'} ${g.name}: ${g.detail.split('\n')[0].slice(0, 110)}`);
      }

      if (result.accepted) {
        record.diff = sandbox.unifiedDiff();
        if (apply) {
          if (gen.testFile) {
            const dest = path.join(config.projectRoot, gen.testFile.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, gen.testFile.contents, 'utf8');
            log(`  ✓ wrote ${gen.testFile.path}`);
          }
          for (const e of gen.edits) {
            const dest = path.join(config.projectRoot, e.path);
            const src = fs.readFileSync(dest, 'utf8');
            fs.writeFileSync(dest, src.replace(e.search, e.replace), 'utf8');
            log(`  ✓ patched ${e.path}`);
          }
        }
        sandbox.destroy(config.projectRoot);
        break;
      }

      sandbox.destroy(config.projectRoot);
      if (attempt === config.gates.maxAttempts) {
        log(`  ✕ giving up after ${attempt} attempts — nothing written`);
        break;
      }
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRetryPrompt(result.feedback ?? 'Unknown failure.') });
    }
    records.push(record);
  }
  return records;
}

/* ------------------------------------------------------------------ commands */


const program = new Command();
program
  .name('rnqa')
  .description('Self-hosted AI engine for React Native test generation and Sonar remediation')
  .version('0.1.0');

program
  .command('analyse')
  .description('Rank files by risk and print the plan. No model is called. Start here.')
  .option('-p, --project <dir>', 'project root', process.cwd())
  .option('-c, --config <file>', 'config file path')
  .option('--skip-coverage', 'skip the baseline jest run', false)
  .option('--json', 'machine-readable output', false)
  .action(async (o) => {
    const config = loadConfig(o.project, o.config);
    const { coverage, issues } = await collectSignals(config, { skipCoverage: o.skipCoverage });
    const tasks = buildTasks(config, coverage, issues);
    const { executable, advisory } = selectExecutable(tasks, config.maxTasks);

    if (o.json) {
      process.stdout.write(JSON.stringify({ executable, advisory }, null, 2));
      return;
    }
    log('\n── PLAN ─────────────────────────────────────────────');
    executable.forEach((t, i) => {
      log(`\n${i + 1}. [${t.tier}] ${t.id}   score ${t.score.toFixed(0)}`);
      t.rationale.forEach((r) => log(`     · ${r}`));
    });
    if (advisory.length) {
      log('\n── ADVISORY (Tier C — engine will not edit these) ────');
      advisory.forEach((t) => log(`   · ${t.id}\n     ${t.rationale[0]}`));
    }
    log(
      `\n${executable.length} task(s) would run, ${advisory.length} advisory, ${tasks.length - executable.length - advisory.length} below the cut.`
    );
  });

program
  .command('run')
  .description('Generate, verify and (optionally) write accepted changes.')
  .option('-p, --project <dir>', 'project root', process.cwd())
  .option('-c, --config <file>', 'config file path')
  .option('--only <substr>', 'restrict to files matching this substring')
  .option('--pull-request <id>', 'scope Sonar issues to a PR')
  .option('--branch <name>', 'scope Sonar issues to a branch')
  .option('--apply', 'write accepted changes into the working tree', false)
  .option('--report <file>', 'HTML report output', 'rnqa-report.html')
  .option('--skip-coverage', 'skip the baseline jest run', false)
  .action(async (o) => {
    const started = Date.now();
    const config = loadConfig(o.project, o.config);
    const provider = createProvider(config);
    log(`▸ provider: ${provider.name}`);

    const { coverage, issues } = await collectSignals(config, {
      skipCoverage: o.skipCoverage,
      pullRequest: o.pullRequest,
      branch: o.branch,
    });
    const tasks = buildTasks(config, coverage, issues, o.only);
    const { executable, advisory } = selectExecutable(tasks, config.maxTasks);
    log(`▸ ${executable.length} executable task(s), ${advisory.length} advisory`);

    log('▸ capturing pre-existing failures (so gates fail only on NEW breakage)…');
    const baseline: Baseline = captureBaseline(config);
    baseline.notes.forEach((n) => log(`  · ${n}`));
    log('');

    const records: RunRecord[] = [];

    for (const task of executable) {
      log(`── ${task.id} [tier ${task.tier}] ─────────────`);
      const firstPrompt =
        task.kind === 'test-generation'
          ? buildTestPrompt(config, task)
          : buildSonarFixPrompt(config, task);

      const messages: ProviderMessage[] = [{ role: 'user', content: firstPrompt }];
      const record: RunRecord = { task, generation: null, result: null, attempts: 0, diff: '' };

      for (let attempt = 1; attempt <= config.gates.maxAttempts; attempt++) {
        record.attempts = attempt;
        log(`  attempt ${attempt}/${config.gates.maxAttempts} — generating…`);

        let raw: string;
        try {
          raw = await provider.complete({
            system: SYSTEM_PROMPT,
            messages,
            maxTokens: 8000,
            temperature: attempt === 1 ? 0.1 : 0.3, // nudge off a stuck answer on retry
          });
        } catch (err) {
          record.error = `Provider error: ${(err as Error).message}`;
          log(`  ✕ ${record.error}`);
          break;
        }

        const gen = parseGeneration(task.id, raw);
        record.generation = gen;

        const { result, sandbox } = await verify(config, task, gen, attempt, coverage, baseline);
        record.result = result;

        for (const g of result.gates) {
          log(`    ${g.passed ? '✓' : '✕'} ${g.name}: ${g.detail.split('\n')[0].slice(0, 110)}`);
        }

        if (result.accepted) {
          record.diff = sandbox.unifiedDiff();
          if (o.apply) {
            if (gen.testFile) {
              const dest = path.join(config.projectRoot, gen.testFile.path);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, gen.testFile.contents, 'utf8');
              log(`  ✓ wrote ${gen.testFile.path}`);
            }
            for (const e of gen.edits) {
              const dest = path.join(config.projectRoot, e.path);
              const src = fs.readFileSync(dest, 'utf8');
              fs.writeFileSync(dest, src.replace(e.search, e.replace), 'utf8');
              log(`  ✓ patched ${e.path}`);
            }
          }
          sandbox.destroy(config.projectRoot);
          break;
        }

        sandbox.destroy(config.projectRoot);
        if (attempt === config.gates.maxAttempts) {
          log(`  ✕ giving up after ${attempt} attempts — nothing written`);
          break;
        }
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: buildRetryPrompt(result.feedback ?? 'Unknown failure.') });
      }

      records.push(record);
      log('');
    }

    const html = renderReport(config, records, advisory, {
      provider: provider.name,
      durationMs: Date.now() - started,
      startedAt: new Date(started).toISOString(),
    });
    const reportPath = path.resolve(config.projectRoot, o.report);
    fs.writeFileSync(reportPath, html, 'utf8');
    log(`▸ report: ${reportPath}`);

    const accepted = records.filter((r) => r.result?.accepted).length;
    const deltas = records
      .filter((r) => r.result?.accepted)
      .map((r) => branchPct(r.result!.coverageAfter) - branchPct(r.result!.coverageBefore));
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    log(`▸ ${accepted}/${records.length} accepted · avg branch coverage +${avg.toFixed(0)}pp`);

    // Non-zero exit if nothing survived the gates — makes the Jenkins stage honest.
    process.exitCode = records.length > 0 && accepted === 0 ? 1 : 0;
  });

program
  .command('feature')
  .description(
    'The developer loop: cover and lint only the files YOU changed, before you raise the PR. Scoped to your git diff, not the whole repo.'
  )
  .option('-p, --project <dir>', 'project root', process.cwd())
  .option('-c, --config <file>', 'config file path')
  .option('--since <ref>', 'compare against this ref (default: merge-base with origin/main)')
  .option('--fast', 'skip the mutation gate to stay inside a pre-PR latency budget', false)
  .option('--apply', 'write accepted changes into the working tree', false)
  .option('--plan', 'show what would run and stop — no model called', false)
  .option('--report <file>', 'HTML report output', 'rnqa-feature.html')
  .action(async (o) => {
    const started = Date.now();
    const config = loadConfig(o.project, o.config);
    if (o.fast) config.gates.skipMutation = true;

    const changed = findChangedFiles(config.projectRoot, o.since);
    const b = changed.breakdown;
    log(`▸ base: ${changed.baseRef}`);
    log(
      `▸ ${changed.files.length} changed file(s) — ${b.committed} committed, ${b.staged} staged, ${b.unstaged} unstaged, ${b.untracked} new`
    );
    if (changed.files.length === 0) {
      log('  nothing changed against that ref — try --since <ref>');
      return;
    }

    const { coverage, issues } = await collectSignals(config, { skipCoverage: false });
    // maxTasks caps a repo-wide sweep; your own diff should not be truncated.
    const scoped = { ...config, maxTasks: Math.max(config.maxTasks, changed.files.length) };
    const tasks = buildTasks(scoped, coverage, issues, undefined, changed.files);
    const { executable, advisory } = selectExecutable(tasks, scoped.maxTasks);

    log(`▸ ${executable.length} task(s) on your changes, ${advisory.length} advisory\n`);
    for (const t of executable) {
      log(`  [${t.tier}] ${t.id}`);
      t.rationale.slice(0, 2).forEach((r) => log(`      · ${r}`));
    }
    if (advisory.length) {
      log('\n  Tier C — reported, never edited:');
      advisory.forEach((t) => log(`      · ${t.id}`));
    }

    if (o.plan) {
      log('\n--plan: stopping before any model call.');
      return;
    }
    if (o.fast) {
      log('\n⚠ --fast: the mutation gate is OFF. Output is not fully verified; CI re-runs it.');
    }

    const provider = createProvider(config);
    log(`▸ provider: ${provider.name}`);
    log('▸ capturing pre-existing failures…');
    const baseline: Baseline = captureBaseline(config);
    baseline.notes.forEach((n) => log(`  · ${n}`));

    const records: RunRecord[] = await runTasks(config, provider, executable, coverage, baseline, o.apply);

    const html = renderReport(config, records, advisory, {
      provider: provider.name + (o.fast ? ' · FAST MODE (mutation gate off)' : ''),
      durationMs: Date.now() - started,
      startedAt: new Date(started).toISOString(),
    });
    fs.writeFileSync(path.resolve(config.projectRoot, o.report), html, 'utf8');
    log(`\n▸ report: ${path.resolve(config.projectRoot, o.report)}`);
    const accepted = records.filter((r) => r.result?.accepted).length;
    log(`▸ ${accepted}/${records.length} accepted`);
  });

program
  .command('doctor')
  .description(
    'Check whether this repo can actually run the engine. Run this FIRST on any new repo — it reports every reason a run would fail or silently skip a gate.'
  )
  .option('-p, --project <dir>', 'project root', process.cwd())
  .option('-c, --config <file>', 'config file path')
  .action(async (o) => {
    const config = loadConfig(o.project, o.config);
    const root = config.projectRoot;
    const checks: { name: string; ok: boolean | 'warn'; detail: string }[] = [];
    const add = (name: string, ok: boolean | 'warn', detail: string): void => {
      checks.push({ name, ok, detail });
    };

    // Memory — the constraint that actually decides whether local inference is
    // viable on this machine.
    const totalGb = os.totalmem() / 1024 ** 3;
    const projectMb = (() => {
      try {
        const out = execFileSync('du', ['-sm', '--exclude=node_modules', root], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        return parseInt(out.split(/\s+/)[0], 10);
      } catch {
        return -1;
      }
    })();
    add(
      'memory headroom',
      totalGb >= 24 ? true : 'warn',
      `${totalGb.toFixed(0)}GB RAM, project ${projectMb > 0 ? `${projectMb}MB` : 'unknown'} (excl. node_modules)` +
        (totalGb < 24
          ? ' — too tight to run a local model AND jest/Stryker at once. Use a remote provider and keep this box for verification only.'
          : '')
    );
    add(
      'resource profile',
      true,
      `jest maxWorkers=${config.jest.maxWorkers ?? 'default'}, stryker concurrency=${config.gates.strykerConcurrency}, regression scope=${config.gates.regressionScope}`
    );

    // Node
    const major = parseInt(process.versions.node.split('.')[0], 10);
    add('node >= 20', major >= 20, `found v${process.versions.node}${major < 20 ? ' — global fetch and fs.cpSync need 20+' : ''}`);

    // Git — the sandbox prefers a worktree; without git it falls back to a copy.
    let hasGit = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
      hasGit = true;
    } catch {
      /* not a repo */
    }
    add(
      'git repository',
      hasGit ? true : 'warn',
      hasGit
        ? 'worktree sandboxing available (fast, isolated)'
        : 'NOT a git repo — sandbox falls back to a full directory copy (slow) and the scope-guard gate is disabled'
    );

    // tsconfig + pre-existing type errors
    const tscBase = captureTscBaseline(root);
    add(
      'typecheck baseline',
      tscBase.available ? true : 'warn',
      tscBase.available
        ? `${tscBase.errors.size} pre-existing type error(s) — these are baselined and ignored`
        : 'tsc produced no parseable diagnostics — the typecheck gate will be SKIPPED'
    );

    // jest
    const jestBase = captureJestBaseline(config, root);
    add(
      'jest baseline',
      jestBase.available ? true : false,
      jestBase.available
        ? `${jestBase.failures.size} already-failing test(s) — baselined and ignored`
        : `"${config.jest.command}" produced no JSON report from ${root} — the engine cannot run`
    );

    // coverage
    let covOk = false;
    let covDetail = '';
    if (config.coverage.source === 'lcov') {
      const paths = config.coverage.lcovPath
        ? resolveLcovPaths(root, config.coverage.lcovPath)
        : [];
      covOk = paths.length > 0;
      covDetail = covOk
        ? `lcov source: ${paths.length} file(s) found — no jest coverage run needed`
        : `coverage.source is "lcov" but nothing matched "${config.coverage.lcovPath ?? '(unset)'}" — run your sharded test job first`;
      add('coverage report', covOk, covDetail);
    } else {
    try {
      const raw = runCoverage(config, {
        outDir: path.join(root, '.rnqa', 'doctor-coverage'),
        silent: true,
      });
      const n = Object.keys(raw).length;
      covOk = n > 0;
      covDetail = `${n} file(s) instrumented`;
      if (n === 0) covDetail += ' — check collectCoverageFrom in your jest config';
    } catch (err) {
      covDetail = (err as Error).message;
    }
    add('coverage report', covOk, covDetail);
    }

    // Stryker — the gate the engine's credibility rests on
    const strykerCore = fs.existsSync(
      path.join(root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js')
    );
    const strykerJest = fs.existsSync(path.join(root, 'node_modules', '@stryker-mutator', 'jest-runner'));
    add(
      'stryker (mutation gate)',
      strykerCore && strykerJest,
      strykerCore && strykerJest
        ? 'installed'
        : 'MISSING — the mutation gate will report SKIPPED (never passed). Run: npm i -D @stryker-mutator/core @stryker-mutator/jest-runner'
    );

    // React Native preset detection
    const pkgPath = path.join(root, 'package.json');
    const pkg = fs.existsSync(pkgPath)
      ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string>>)
      : {};
    const isRN = Boolean(pkg.dependencies?.['react-native']);
    add(
      'react-native project',
      isRN ? true : 'warn',
      isRN ? `react-native ${pkg.dependencies['react-native']}` : 'no react-native dependency found'
    );

    // Testing conventions — a generated test that imports a library this repo
    // does not have will fail at import, every time.
    const conv = detectConventions(root, true);
    add(
      'testing library',
      conv.library !== 'none',
      conv.library === 'none'
        ? 'none detected — component tests cannot be generated, only pure functions'
        : `${conv.library}` +
          (conv.exemplarPath
            ? `, style exemplar: ${path.relative(root, conv.exemplarPath)}`
            : ' (no existing test found to use as a style exemplar)')
    );

    // Provider reachability — a local model that is not running is the most
    // common "the engine does nothing" cause.
    let providerOk: boolean | 'warn' = 'warn';
    let providerDetail = `${config.provider.kind}:${config.provider.model}`;
    if (config.provider.kind === 'ollama') {
      try {
        const res = await fetch(`${config.provider.baseUrl}/api/tags`);
        const body = (await res.json()) as { models?: { name: string }[] };
        const names = (body.models ?? []).map((m) => m.name);
        providerOk = names.includes(config.provider.model);
        providerDetail = providerOk
          ? `${config.provider.model} available`
          : `reachable, but "${config.provider.model}" is not pulled. Available: ${names.join(', ') || '(none)'}`;
      } catch {
        providerOk = false;
        providerDetail = `cannot reach ollama at ${config.provider.baseUrl} — is it running?`;
      }
    } else {
      providerDetail += ' — not probed (only ollama is checked locally)';
    }
    add('llm provider', providerOk, providerDetail);

    // Sonar
    add(
      'sonarqube',
      config.sonar.enabled ? Boolean(config.sonar.token) : 'warn',
      config.sonar.enabled
        ? config.sonar.token
          ? `enabled for ${config.sonar.projectKey}`
          : 'enabled but SONAR_TOKEN is not set'
        : 'disabled — test generation only'
    );

    log('\n── DOCTOR ───────────────────────────────────────────');
    for (const c of checks) {
      const mark = c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✕';
      log(`  ${mark} ${c.name.padEnd(24)} ${c.detail}`);
    }
    const blockers = checks.filter((c) => c.ok === false);
    log(
      blockers.length
        ? `\n✕ ${blockers.length} blocker(s): ${blockers.map((b) => b.name).join(', ')}`
        : '\n✓ ready — run `rnqa analyse` next'
    );
    process.exitCode = blockers.length ? 1 : 0;
  });

program
  .command('verify-file')
  .description(
    'Run the full gate suite against an EXISTING test file. No model involved — use this to prove the gates, or to audit hand-written tests.'
  )
  .requiredOption('--target <file>', 'source file under test (relative to project)')
  .requiredOption(
    '--test <file>',
    'candidate test file on disk (repeatable)',
    (v: string, acc: string[]) => acc.concat(v),
    [] as string[]
  )
  .option(
    '--as <file>',
    'path to write the candidate to inside the sandbox, paired positionally with --test (repeatable). Use this to keep candidates out of the baseline run.',
    (v: string, acc: string[]) => acc.concat(v),
    [] as string[]
  )
  .option('--report <file>', 'write an HTML report')
  .option('-p, --project <dir>', 'project root', process.cwd())
  .option('-c, --config <file>', 'config file path')
  .action(async (o) => {
    const config = loadConfig(o.project, o.config);
    const targetAbs = path.resolve(config.projectRoot, o.target);

    log('▸ baseline coverage…');
    const coverageBase = summariseAll(
      runCoverage(config, {
        outDir: path.join(config.projectRoot, '.rnqa', 'coverage-base'),
        silent: true,
      })
    );

    log('▸ capturing pre-existing failures…');
    const baseline: Baseline = captureBaseline(config);
    baseline.notes.forEach((n) => log(`  · ${n}`));

    const project = createProject(config.projectRoot);
    const facts = extractFacts(project, targetAbs);
    const records: RunRecord[] = [];
    let allAccepted = true;

    for (let i = 0; i < o.test.length; i++) {
      const testSrc = o.test[i];
      const destPath = o.as[i] ?? testSrc;
      log(`\n── ${testSrc} → ${destPath} ─────────────`);

      const task: Task = {
        id: `verify:${testSrc}`,
        kind: 'test-generation',
        tier: 'B',
        targetPath: targetAbs,
        existingTestPath: null,
        coverage: coverageBase.get(targetAbs) ?? null,
        sonarIssues: [],
        facts,
        score: 0,
        rationale: [`Manual verification of ${testSrc} against ${o.target}.`],
      };

      const contents = fs.readFileSync(path.resolve(config.projectRoot, testSrc), 'utf8');
      const gen = parseGeneration(task.id, '');
      gen.testFile = { path: destPath, contents };

      const { result, sandbox } = await verify(config, task, gen, 1, coverageBase, baseline);
      for (const g of result.gates) {
        log(`  ${g.passed ? '✓' : '✕'} ${g.name}: ${g.detail}`);
      }
      log(`  ▸ ${result.accepted ? 'ACCEPTED' : 'REJECTED'}`);

      records.push({
        task,
        generation: gen,
        result,
        attempts: 1,
        diff: result.accepted ? sandbox.unifiedDiff() : '',
      });
      if (!result.accepted) allAccepted = false;
      sandbox.destroy(config.projectRoot);
    }

    if (o.report) {
      const html = renderReport(config, records, [], {
        provider: 'none (verify-file: no model involved)',
        durationMs: 0,
        startedAt: new Date().toISOString(),
      });
      const rp = path.resolve(config.projectRoot, o.report);
      fs.writeFileSync(rp, html, 'utf8');
      log(`\n▸ report: ${rp}`);
    }

    process.exitCode = allAccepted ? 0 : 1;
  });

program.parseAsync(process.argv).catch((err: Error) => {
  log(`\n✕ ${err.message}`);
  process.exitCode = 1;
});
