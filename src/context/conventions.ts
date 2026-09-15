import * as fs from 'fs';
import * as path from 'path';

/**
 * Detects how THIS repo writes tests, instead of assuming.
 *
 * Found the hard way on a real React Native app: the engine's prompt mandated
 * @testing-library/react-native, the repo used react-test-renderer, and every
 * generated component test would have failed at import. A generated test that
 * does not match the repo's conventions gets deleted by the developer, which is
 * the same as producing nothing — but slower and more annoying.
 */

export type TestLibrary = 'rntl' | 'react-test-renderer' | 'enzyme' | 'none';

export interface TestConventions {
  library: TestLibrary;
  /** Human-readable instruction block injected into the prompt. */
  renderingGuidance: string;
  /** Path to a real test from this repo, used as a style exemplar. */
  exemplarPath: string | null;
  exemplarText: string | null;
  /** Where tests live: colocated next to source, or a top-level directory. */
  layout: 'colocated' | 'top-level' | 'unknown';
}

function has(projectRoot: string, pkg: string): boolean {
  return fs.existsSync(path.join(projectRoot, 'node_modules', ...pkg.split('/')));
}

const GUIDANCE: Record<TestLibrary, string> = {
  rntl: `Use @testing-library/react-native.
- Query with user-centric queries: getByText, getByRole, getByLabelText.
- Use fireEvent for interaction; await findBy* or wrap in waitFor for async.
- Do not use test IDs unless they already exist in the source.`,

  'react-test-renderer': `Use react-test-renderer. @testing-library/react-native is NOT installed — do not import it.
- Render with ReactTestRenderer.create(...) inside act().
- Traverse with root.findAllByType(...) / root.findByProps(...) and assert on props and rendered text.
- Invoke handlers directly (e.g. node.props.onPress()) rather than firing DOM-style events.
- For async work, await act(async () => {}) to flush promises.`,

  enzyme: `Use enzyme with its configured adapter, matching the existing tests in this repo.`,

  none: `No component testing library is installed. Test exported functions and
hooks directly. Do NOT write a test that renders a component — it cannot run.
If the target file only exports components, emit no test file and say so in
<rationale>.`,
};

function findExemplar(projectRoot: string, preferTsx: boolean): string | null {
  const roots = ['__tests__', 'src', 'app', 'test', 'tests'];
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length > 40) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'ios', 'android', '_archive', 'vendor'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(e.name)) {
        found.push(full);
      }
    }
  };

  for (const r of roots) {
    const dir = path.join(projectRoot, r);
    if (fs.existsSync(dir)) walk(dir, 0);
  }
  if (found.length === 0) return null;

  // Prefer a .tsx exemplar for component targets, and a middling-size file:
  // a 10-line smoke test teaches nothing, a 900-line one blows the budget.
  const pool = preferTsx ? found.filter((f) => f.endsWith('.tsx')) : found.filter((f) => !f.endsWith('.tsx'));
  const candidates = (pool.length ? pool : found)
    .map((f) => ({ f, size: fs.statSync(f).size }))
    .filter((x) => x.size > 300 && x.size < 12000)
    .sort((a, b) => a.size - b.size);

  return candidates[Math.floor(candidates.length / 2)]?.f ?? null;
}

export function detectConventions(projectRoot: string, forComponent: boolean): TestConventions {
  let library: TestLibrary = 'none';
  if (has(projectRoot, '@testing-library/react-native')) library = 'rntl';
  else if (has(projectRoot, 'react-test-renderer')) library = 'react-test-renderer';
  else if (has(projectRoot, 'enzyme')) library = 'enzyme';

  const exemplarPath = findExemplar(projectRoot, forComponent);
  let exemplarText: string | null = null;
  if (exemplarPath) {
    try {
      exemplarText = fs.readFileSync(exemplarPath, 'utf8').slice(0, 6000);
    } catch {
      exemplarText = null;
    }
  }

  let layout: TestConventions['layout'] = 'unknown';
  if (exemplarPath) {
    layout = /(^|[\\/])__tests__[\\/]/.test(path.relative(projectRoot, exemplarPath))
      ? 'top-level'
      : 'colocated';
  }

  return { library, renderingGuidance: GUIDANCE[library], exemplarPath, exemplarText, layout };
}

/**
 * Directories Stryker must not copy into its sandbox.
 *
 * Without this, Stryker copies the entire project — including ios/Pods, whose
 * .framework bundles contain symlinked "Versions/Current" directories. The copy
 * dies with EISDIR and the mutation gate silently reports SKIPPED. On the repo
 * this was found on, the abandoned sandbox left 2.4GB behind.
 */
export const DEFAULT_STRYKER_IGNORES = [
  'ios/**',
  'android/**',
  'vendor/**',
  '_archive/**',
  'server/**',
  'coverage/**',
  '.git/**',
  '.rnqa/**',
  'e2e/**',
  'fastlane/**',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.svg',
  '**/*.mp4',
  '**/*.zip',
  '**/*.keystore',
  '**/*.xcframework/**',
];
