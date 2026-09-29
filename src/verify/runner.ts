import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runCoverage, summariseAll, branchPct } from '../signal/coverage';
import { Baseline, EMPTY_BASELINE, parseJestFailures, parseTscErrors } from './baseline';
import { mutationScore } from './mutation';
import { Sandbox } from './sandbox';
import { EngineConfig, Generation, Task, VerifyGate, VerifyResult } from '../types';

function run(
  cmd: string,
  args: string[],
  cwd: string
): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim() };
  }
}

function tail(s: string, lines = 40): string {
  return s.split('\n').slice(-lines).join('\n');
}

/**
 * The verification loop. Every gate is objective and re-runnable by a human with
 * the same commands — nothing here is the model's opinion of its own work.
 *
 * Order matters: cheapest, most-likely-to-fail gates first, so a bad generation
 * is rejected in seconds rather than after a 10-minute mutation run.
 */
export async function verify(
  config: EngineConfig,
  task: Task,
  gen: Generation,
  attempt: number,
  coverageBefore: Map<string, ReturnType<typeof summariseAll> extends Map<string, infer V> ? V : never>,
  baseline: Baseline = EMPTY_BASELINE
): Promise<{ result: VerifyResult; sandbox: Sandbox }> {
  const gates: VerifyGate[] = [];
  const sandbox = Sandbox.create(config.projectRoot, task.id);
  const targetRel = path.relative(config.projectRoot, task.targetPath);

  // When the baseline came from an lcov file produced by a sharded CI run, its
  // numbers are not methodologically identical to an istanbul run (lcov has no
  // statement map, and branch arms are counted differently). Comparing the two
  // would produce a meaningless delta, so measure the "before" here, in the
  // still-pristine sandbox, scoped to just this file — cheap, and apples to
  // apples with the "after" measurement below.
  let before = coverageBefore.get(task.targetPath) ?? null;
  if (task.kind === 'test-generation' && config.coverage.source === 'lcov') {
    try {
      const pristine = summariseAll(
        runCoverage(config, {
          cwd: sandbox.root,
          outDir: path.join(sandbox.root, '.rnqa', 'coverage-pristine'),
          silent: true,
          collectCoverageFrom: [targetRel],
          findRelatedTests: [targetRel],
        })
      );
      before = pristine.get(path.join(sandbox.root, targetRel)) ?? before;
    } catch {
      /* fall back to the lcov numbers and accept the looser comparison */
    }
  }

  const fail = (feedback: string): { result: VerifyResult; sandbox: Sandbox } => ({
    result: {
      taskId: task.id,
      accepted: false,
      attempt,
      gates,
      feedback,
      coverageBefore: before,
      coverageAfter: null,
      mutationScore: null,
    },
    sandbox,
  });

  // ---- Gate 0: apply -------------------------------------------------------
  let testRel: string | null = null;
  try {
    if (gen.testFile) {
      testRel = gen.testFile.path;
      sandbox.writeFile(testRel, gen.testFile.contents);
    }
    for (const edit of gen.edits) sandbox.applyEdit(edit.path, edit.search, edit.replace);
    gates.push({
      name: 'apply',
      passed: true,
      detail: `Wrote ${gen.testFile ? 1 : 0} test file, applied ${gen.edits.length} edit(s).`,
    });
  } catch (err) {
    const detail = (err as Error).message;
    gates.push({ name: 'apply', passed: false, detail });
    return fail(`FAILED GATE: apply\n${detail}\nThe SEARCH text must match the file byte-for-byte.`);
  }

  if (!gen.testFile && gen.edits.length === 0) {
    gates.push({ name: 'apply', passed: false, detail: 'Model produced no test file and no edits.' });
    return fail('FAILED GATE: apply\nYou produced neither a <test-file> nor a <patch> block.');
  }

  // ---- Gate 1: scope guard -------------------------------------------------
  if (config.gates.enforceScope) {
    const allowed = new Set<string>([targetRel, ...(testRel ? [testRel] : [])]);
    // Sandbox infrastructure is not model output. node_modules in particular
    // is SYMLINKED into the worktree, and a .gitignore entry of "node_modules/"
    // does not match a symlink — so git reports it as an untracked change and
    // the scope guard rejects every generation on any real repo.
    // Matches at ANY depth — a monorepo's `server/node_modules` is as much
    // sandbox infrastructure as the root one.
    const INFRA =
      /(^|\/)(node_modules|\.rnqa|\.stryker-tmp|coverage|dist|rnqa-report\.html|rnqa-feature\.html|stryker\.rnqa\.json)($|\/)/;
    const changed = sandbox.changedFiles();
    const outOfScope = changed.filter((f) => !allowed.has(f) && !INFRA.test(f));
    const passed = outOfScope.length === 0;
    gates.push({
      name: 'scope-guard',
      passed,
      detail: passed
        ? `Changes confined to ${[...allowed].join(', ')}.`
        : `Out-of-scope edits: ${outOfScope.join(', ')}`,
    });
    if (!passed) {
      return fail(
        `FAILED GATE: scope-guard\nYou edited files outside the task: ${outOfScope.join(', ')}.\nEdit only ${[...allowed].join(' and ')}.`
      );
    }
  }

  // ---- Gate 2: typecheck (DIFFERENTIAL) ------------------------------------
  // Real repos carry pre-existing type errors. An absolute gate would reject
  // every generation forever for failures it did not cause.
  if (!baseline.tscAvailable) {
    gates.push({ name: 'typecheck', passed: true, detail: 'SKIPPED — no usable tsc baseline.' });
  } else {
    const tsc = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], sandbox.root);
    const after = parseTscErrors(tsc.output);
    const introduced = [...after].filter((sig) => !baseline.tscErrors.has(sig));
    const passed = introduced.length === 0;
    gates.push({
      name: 'typecheck',
      passed,
      detail: passed
        ? `No new type errors (${baseline.tscErrors.size} pre-existing, ignored).`
        : `${introduced.length} NEW type error(s):\n${introduced.slice(0, 10).join('\n')}`,
    });
    if (!passed) {
      return fail(
        `FAILED GATE: typecheck\nYour change introduced ${introduced.length} new type error(s):\n${introduced.slice(0, 10).join('\n')}`
      );
    }
  }

  // ---- Gate 3: the new tests pass -----------------------------------------
  const [jestBin, ...jestArgsBase] = config.jest.command.split(/\s+/);
  const jestArgs = config.jest.maxWorkers
    ? [...jestArgsBase, `--maxWorkers=${config.jest.maxWorkers}`]
    : jestArgsBase;
  const targetTest = testRel ?? targetRel;
  const newTests = run(
    jestBin,
    [...jestArgs, '--ci', '--passWithNoTests=false', `--testPathPattern=${escapeRe(targetTest)}`],
    sandbox.root
  );
  gates.push({
    name: 'generated-tests-pass',
    passed: newTests.ok,
    detail: newTests.ok ? 'All generated tests pass.' : tail(newTests.output, 30),
  });
  if (!newTests.ok) {
    return fail(`FAILED GATE: generated-tests-pass\n${tail(newTests.output, 40)}`);
  }

  // ---- Gate 4: no regression (DIFFERENTIAL) --------------------------------
  // Same reasoning as the typecheck gate: most repos have some already-failing
  // or flaky tests. Only NEW failures are the generation's fault.
  if (!baseline.jestAvailable) {
    gates.push({ name: 'no-regression', passed: true, detail: 'SKIPPED — no usable jest baseline.' });
  } else {
    const jsonOut = path.join(sandbox.root, '.rnqa', 'jest-after.json');
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });

    // On a large repo the full suite per attempt is the dominant cost. A
    // test-generation task only ADDS a file, which can break other tests only
    // through shared global state, so 'related' is the sensible default.
    const regressionArgs =
      config.gates.regressionScope === 'related'
        ? [...jestArgs, '--ci', '--silent', '--json', `--outputFile=${jsonOut}`, '--findRelatedTests', targetRel]
        : [...jestArgs, '--ci', '--silent', '--json', `--outputFile=${jsonOut}`];
    run(jestBin, regressionArgs, sandbox.root);
    if (!fs.existsSync(jsonOut)) {
      gates.push({ name: 'no-regression', passed: true, detail: 'SKIPPED — jest produced no report.' });
    } else {
      const after = parseJestFailures(fs.readFileSync(jsonOut, 'utf8'));
      const introduced = [...after].filter((t) => !baseline.failingTests.has(t));
      const passed = introduced.length === 0;
      gates.push({
        name: 'no-regression',
        passed,
        detail: passed
          ? `No new failures [scope: ${config.gates.regressionScope}] (${baseline.failingTests.size} already failing before this change, ignored).`
          : `${introduced.length} NEWLY failing test(s):\n${introduced.slice(0, 10).join('\n')}`,
      });
      if (!passed) {
        return fail(
          `FAILED GATE: no-regression\nYour change broke tests that were passing before:\n${introduced.slice(0, 10).join('\n')}`
        );
      }
    }
  }

  // ---- Gate 5: coverage actually moved ------------------------------------
  let coverageAfter = null;
  if (task.kind === 'test-generation') {
    const rawAfter = runCoverage(config, {
      cwd: sandbox.root,
      outDir: path.join(sandbox.root, '.rnqa', 'coverage-after'),
      silent: true,
      collectCoverageFrom: [targetRel],
      findRelatedTests: [targetRel],
    });
    const afterMap = summariseAll(rawAfter);
    coverageAfter = afterMap.get(path.join(sandbox.root, targetRel)) ?? null;

    const beforePct = branchPct(before);
    const afterPct = branchPct(coverageAfter);
    const deltaB = afterPct - beforePct;

    // A file already at 94% cannot gain 15 points — there are only 6 left.
    // Requiring a flat delta rejects a perfect result on exactly the files
    // that are closest to done, so the requirement is capped by what is
    // actually available, and reaching 100% always passes.
    const available = 100 - beforePct;
    const required = Math.min(config.gates.minBranchCoverageDelta, available);
    const wellCovered = beforePct >= config.gates.wellCoveredAt;
    const passed = wellCovered || afterPct >= 100 || deltaB >= required - 1e-9;

    gates.push({
      name: 'coverage-delta',
      passed,
      value: deltaB,
      detail: wellCovered
        ? `Branch coverage ${beforePct.toFixed(0)}% → ${afterPct.toFixed(0)}% (Δ ${deltaB.toFixed(0)}pp). ` +
          `Already ≥${config.gates.wellCoveredAt}% — informational only; mutation-score decides.`
        : `Branch coverage ${beforePct.toFixed(0)}% → ${afterPct.toFixed(0)}% ` +
          `(Δ ${deltaB.toFixed(0)}pp, need ≥${required.toFixed(0)}pp` +
          (required < config.gates.minBranchCoverageDelta
            ? ` — capped from ${config.gates.minBranchCoverageDelta}pp, only ${available.toFixed(0)}pp were available)`
            : ')') +
          '.',
    });
    if (!passed) {
      const stillUncovered = coverageAfter?.uncoveredBranchLines.join(', ') ?? 'unknown';
      return fail(
        `FAILED GATE: coverage-delta\nBranch coverage only moved ${deltaB.toFixed(0)}pp.\nStill-uncovered branch arms on lines: ${stillUncovered}\nAdd a test case that drives each of those arms specifically.`
      );
    }
  }

  // ---- Gate 6: mutation score ---------------------------------------------
  let mScore: number | null = null;
  if (config.gates.skipMutation) {
    gates.push({
      name: 'mutation-score',
      passed: true,
      detail: 'NOT RUN (--fast). This output is not verified to the usual standard — CI re-runs it with the gate on.',
    });
  } else if (task.kind === 'test-generation' && testRel) {
    const m = await mutationScore(config, sandbox, targetRel, testRel);
    mScore = m.score;
    if (m.score === null) {
      gates.push({ name: 'mutation-score', passed: true, detail: `SKIPPED — ${m.detail}` });
    } else {
      const passed = m.score >= config.gates.minMutationScore;
      gates.push({ name: 'mutation-score', passed, value: m.score, detail: m.detail });
      if (!passed) {
        return fail(
          `FAILED GATE: mutation-score\n${m.detail}\nYour tests execute the code but do not assert on its behaviour. Surviving mutants mean a line could be changed to something wrong and your tests would still pass.\nReplace weak assertions (toBeTruthy, toBeDefined, snapshot-only) with assertions on concrete rendered output, call arguments, and return values.`
        );
      }
    }
  }

  return {
    result: {
      taskId: task.id,
      accepted: true,
      attempt,
      gates,
      feedback: null,
      coverageBefore: before,
      coverageAfter,
      mutationScore: mScore,
    },
    sandbox,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
