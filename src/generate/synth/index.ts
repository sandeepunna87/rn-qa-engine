import * as path from 'path';
import * as fs from 'fs';
import { createProject } from '../../context/facts';
import { EngineConfig, Generation, Task } from '../../types';
import { emitTestFile } from './emit';
import { buildFixtures, findFunctionTargets, Fixture } from './fixtures';
import { runProbe } from './probe';

/**
 * Where generated tests go.
 *
 * NEVER the path of an existing hand-written test. `testPathFor` returns the
 * existing file when there is one, which would have this generator silently
 * overwrite a developer's own work. Generated output lives in its own
 * `.rnqa.test.ts` file alongside it: both suites run, coverage is the union,
 * and deleting the generated one is a single unambiguous action.
 */
function generatedTestPath(config: EngineConfig, targetAbs: string): string {
  const dir = path.dirname(targetAbs);
  const base = path.basename(targetAbs).replace(/\.(tsx?|jsx?)$/, '');
  const ext = targetAbs.endsWith('.tsx') ? 'tsx' : 'ts';
  const testDir = path.join(dir, config.testGlob);
  return fs.existsSync(testDir)
    ? path.join(testDir, `${base}.rnqa.test.${ext}`)
    : path.join(dir, `${base}.rnqa.test.${ext}`);
}

/**
 * The built-in generator: derive → probe → emit. No model, no network, no GPU.
 *
 * Stage 1 covers exported plain functions. Components are deliberately out of
 * scope: their inputs arrive through props and stores rather than parameters,
 * which needs a tracing layer that stage 2 adds.
 */
export function synthesize(config: EngineConfig, task: Task): Generation & { note: string } {
  const empty = (note: string): Generation & { note: string } => ({
    taskId: task.id,
    testFile: null,
    edits: [],
    rationale: note,
    raw: '',
    note,
  });

  if (task.kind !== 'test-generation') {
    return empty('The built-in generator only writes tests. Sonar fixes need a model, or Tier A rules.');
  }

  const project = createProject(config.projectRoot);
  const sf = project.addSourceFileAtPathIfExists(task.targetPath) ?? project.addSourceFileAtPath(task.targetPath);

  const targets = findFunctionTargets(sf);
  if (targets.length === 0) {
    return empty(
      task.facts.isComponent
        ? 'This is a component — its inputs come from props and stores, not parameters. Stage 2 handles those; the built-in generator writes nothing rather than a test that cannot drive the branches.'
        : 'No exported plain functions found to exercise.'
    );
  }

  const fixtures: Fixture[] = [];
  for (const t of targets) fixtures.push(...buildFixtures(sf, t));

  if (fixtures.length === 0) return empty('No inputs could be derived from the type signatures.');

  const { results, error } = runProbe(config, task.targetPath, fixtures);
  if (error) return empty(error);

  const testAbsPath = generatedTestPath(config, task.targetPath);
  const { contents, stats } = emitTestFile({
    testAbsPath,
    targetAbsPath: task.targetPath,
    fixtures,
    results,
  });

  if (stats.cases === 0) {
    return empty(
      `Probed ${fixtures.length} fixture(s) but none produced a value that can be asserted on (promises, functions and circular structures are skipped).`
    );
  }

  const note =
    `Derived ${fixtures.length} fixture(s) across ${targets.length} function(s); ` +
    `emitted ${stats.cases} case(s) (${stats.throws} expecting a throw), skipped ${stats.skipped}. ` +
    `Expected values are what the code returned when probed — characterization, not correctness.`;

  return {
    taskId: task.id,
    testFile: {
      path: path.relative(config.projectRoot, testAbsPath),
      contents,
    },
    edits: [],
    rationale: note,
    raw: '',
    note,
  };
}
