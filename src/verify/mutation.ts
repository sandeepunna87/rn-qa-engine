import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_STRYKER_IGNORES } from '../context/conventions';
import { EngineConfig } from '../types';
import { Sandbox } from './sandbox';

/**
 * THE gate that matters.
 *
 * Coverage says a line executed. Mutation testing says an assertion would have
 * caught it being wrong. Stryker mutates the source file (flips conditionals,
 * swaps operators, empties blocks) and re-runs only the generated test. Every
 * surviving mutant is a line the test executes but does not actually check.
 *
 * Without this gate, an LLM will happily produce a file full of
 * `expect(render(<X/>)).toBeTruthy()` that lifts coverage to 95% and catches
 * nothing. That output is worse than no tests, because it retires the file from
 * anyone's attention.
 */
export async function mutationScore(
  config: EngineConfig,
  sandbox: Sandbox,
  targetRelPath: string,
  _testRelPath: string
): Promise<{ score: number | null; detail: string }> {
  // Locate the project's jest config. Stryker's `jest.configFile` and an inline
  // `jest.config` object are mutually exclusive — passing both silently aborts
  // the run, which is how this gate ends up quietly "skipped" forever.
  const jestConfigFile =
    config.jest.configPath ??
    ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.json'].find((f) =>
      fs.existsSync(path.join(sandbox.root, f))
    ) ??
    null;

  const strykerConfig = {
    packageManager: 'npm',
    testRunner: 'jest',
    jest: {
      projectType: 'custom',
      ...(jestConfigFile ? { configFile: jestConfigFile } : {}),
    },
    // Stryker copies the project into its own sandbox before mutating. On a
    // React Native repo that copy hits ios/Pods, whose .framework bundles
    // contain symlinked "Versions/Current" directories, and dies with EISDIR —
    // leaving gigabytes behind and reporting the gate as SKIPPED.
    ignorePatterns: [...DEFAULT_STRYKER_IGNORES, ...config.gates.strykerIgnorePatterns],
    cleanTempDir: true,
    // Mutate ONLY the file under test — mutating the repo would take hours.
    // With coverageAnalysis "perTest", Stryker then runs just the tests that
    // actually cover each mutant, so scoping the test set is unnecessary.
    mutate: [targetRelPath],
    reporters: ['json'],
    jsonReporter: { fileName: '.rnqa/mutation.json' },
    coverageAnalysis: 'perTest',
    timeoutMS: 20000,
    concurrency: config.gates.strykerConcurrency,
    disableTypeChecks: true,
  };

  const cfgPath = path.join(sandbox.root, 'stryker.rnqa.json');
  fs.writeFileSync(cfgPath, JSON.stringify(strykerConfig, null, 2));

  // Resolve the LOCAL stryker binary. `npx stryker` will happily download an
  // unrelated package of that name from the registry when local resolution
  // fails — in an air-gapped build that is both a failure and a surprise.
  const strykerBin = [
    path.join(sandbox.root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js'),
    path.join(config.projectRoot, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js'),
  ].find((p) => fs.existsSync(p));

  if (!strykerBin) {
    return {
      score: null,
      detail:
        'Stryker not installed — gate SKIPPED, NOT passed. Run: npm i -D @stryker-mutator/core @stryker-mutator/jest-runner',
    };
  }

  let stderr = '';
  try {
    execFileSync(process.execPath, [strykerBin, 'run', cfgPath], {
      cwd: sandbox.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
  } catch (err) {
    // Stryker exits non-zero when the score is under its own threshold; the
    // report is still written. Only a missing report is a real failure — but
    // keep stderr so a genuinely broken run is diagnosable, not silent.
    const e = err as { stderr?: Buffer | string; message?: string };
    stderr = String(e.stderr ?? e.message ?? '').split('\n').slice(-6).join('\n');
  }

  const reportPath = path.join(sandbox.root, '.rnqa', 'mutation.json');
  if (!fs.existsSync(reportPath)) {
    return {
      score: null,
      detail: `Stryker produced no report — gate SKIPPED, NOT passed.${stderr ? ` Last output: ${stderr}` : ' Is @stryker-mutator/core + @stryker-mutator/jest-runner installed?'}`,
    };
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
    files: Record<string, { mutants: { status: string }[] }>;
  };

  let killed = 0;
  let survived = 0;
  const survivors: string[] = [];
  for (const [file, data] of Object.entries(report.files)) {
    for (const m of data.mutants) {
      if (m.status === 'Killed' || m.status === 'Timeout') killed++;
      else if (m.status === 'Survived' || m.status === 'NoCoverage') {
        survived++;
        if (survivors.length < 8) survivors.push(`${path.basename(file)}:${m.status}`);
      }
    }
  }

  const total = killed + survived;
  if (total === 0) return { score: null, detail: 'No mutants generated — gate SKIPPED.' };

  const score = (killed / total) * 100;
  return {
    score,
    detail:
      `${killed}/${total} mutants killed (${score.toFixed(0)}%).` +
      (survived > 0 ? ` Survivors: ${survivors.join(', ')}` : ''),
  };
}
