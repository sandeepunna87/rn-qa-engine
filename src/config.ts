import * as fs from 'fs';
import * as path from 'path';
import { EngineConfig } from './types';

/**
 * Defaults are tuned for "POC on one RN repo". Every threshold here is a policy
 * decision, not a technical one — keep them in config so the team can argue
 * about numbers without touching code.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  projectRoot: process.cwd(),
  include: ['src/**/*.ts', 'src/**/*.tsx', 'app/**/*.ts', 'app/**/*.tsx'],
  exclude: [
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.d.ts',
    '**/__tests__/**',
    '**/__mocks__/**',
    '**/node_modules/**',
    '**/*.stories.tsx',
  ],
  testGlob: '__tests__',
  // Default to running jest. Repos that already shard and emit lcov for Sonar
  // should switch to 'lcov' — re-running an unsharded full suite just to rank
  // files is the most expensive thing the engine can do, and pointless when
  // the answer already exists.
  coverage: { source: 'jest', lcovPath: null },
  // maxWorkers=2 is deliberate: jest defaults to cpus-1 workers, and on a 16GB
  // machine a large React Native repo will exhaust memory before it finishes.
  jest: { command: 'npx jest', configPath: null, maxWorkers: '2' },
  sonar: {
    enabled: false,
    baseUrl: '',
    token: '',
    projectKey: '',
    newCodeOnly: true,
    // Tier A allowlist. Deliberately short. Anything not on this list needs a human.
    autoFixRules: [
      'typescript:S1128', // unused import
      'typescript:S1854', // dead store
      'typescript:S1481', // unused local variable
      'typescript:S2589', // gratuitous boolean expression
      'typescript:S3358', // nested ternary
      'typescript:S1116', // empty statement
      'typescript:S6544', // no misused promises
      'typescript:S4325', // unnecessary type assertion
      'typescript:S6479', // no array index key
      'typescript:S1440', // use === not ==
    ],
  },
  // Any file whose path matches these is Tier C: the engine reports, never edits.
  // Domain-neutral defaults covering the places where a plausible-looking wrong
  // fix is expensive in any application. Replace with your repo's real folder
  // names before the first run -- substring matching only works if it matches.
  sensitivePathPatterns: [
    'auth',
    'login',
    'session',
    'token',
    'credential',
    'password',
    'secret',
    'crypto',
    'encrypt',
    'keychain',
    'keystore',
    'biometric',
    'permission',
    'admin',
    'billing',
    'payment',
    'otp',
    'mfa',
  ],
  provider: {
    kind: 'ollama',
    model: 'qwen2.5-coder:32b',
    baseUrl: 'http://127.0.0.1:11434',
  },
  gates: {
    // Below this, the generated tests assert nothing meaningful. This is the
    // gate that separates a real engine from a coverage-number inflator.
    minMutationScore: 60,
    minBranchCoverageDelta: 15,
    maxAttempts: 3,
    enforceScope: true,
    regressionScope: 'related',
    wellCoveredAt: 85,
    strykerConcurrency: 2,
    strykerIgnorePatterns: [],
    ignoreStaticMutants: true,
    skipMutation: false,
  },
  maxTasks: 5,
};

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function loadConfig(projectRoot: string, explicitPath?: string): EngineConfig {
  const configPath = explicitPath ?? path.join(projectRoot, 'rnqa.config.json');
  let fileConfig: unknown = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid config at ${configPath}: ${(err as Error).message}`);
    }
  }
  const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
  merged.projectRoot = path.resolve(projectRoot);

  // Secrets never live in the config file — resolve from env at load time.
  if (!merged.sonar.token && process.env.SONAR_TOKEN) {
    merged.sonar.token = process.env.SONAR_TOKEN;
  }
  return merged;
}
