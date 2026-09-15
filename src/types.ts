/**
 * Core contracts for the engine. Everything that crosses a module boundary is
 * typed here so the LLM layer can be swapped without touching triage/verify.
 */

export type Tier =
  | 'A' // deterministic, safe to auto-fix and auto-open a PR
  | 'B' // generated, requires human review (tests, complexity refactors)
  | 'C'; // advisory only — engine never writes code (auth, crypto, security)

export type TaskKind = 'test-generation' | 'sonar-fix' | 'complexity-refactor';

/** Istanbul coverage, reduced to only what the prompt and triage actually need. */
export interface FileCoverage {
  /** Absolute path on disk. */
  path: string;
  statements: { covered: number; total: number };
  branches: { covered: number; total: number };
  functions: { covered: number; total: number };
  /** 1-indexed source lines with zero statement hits. */
  uncoveredLines: number[];
  /** 1-indexed lines where at least one branch arm was never taken. */
  uncoveredBranchLines: number[];
  /** Names of exported functions/components with zero invocations. */
  uncoveredFunctions: string[];
}

/** A single SonarQube issue, normalised from /api/issues/search. */
export interface SonarIssue {
  key: string;
  rule: string; // e.g. "typescript:S3776"
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';
  type: 'CODE_SMELL' | 'BUG' | 'VULNERABILITY';
  message: string;
  path: string; // absolute
  line: number;
  effortMinutes: number;
}

/** Structural facts extracted with ts-morph — never guessed by the model. */
export interface FileFacts {
  path: string;
  isComponent: boolean;
  /** Default + named exports the tests are allowed to import. */
  exports: string[];
  /** Resolved local imports, so the prompt can carry real type definitions. */
  localImports: { specifier: string; resolvedPath: string | null }[];
  /** Third-party imports — drives which native modules must be mocked. */
  externalImports: string[];
  /** Source text of the props interface/type, verbatim. */
  propsTypeText: string | null;
  /** React hooks used, so the test knows what to flush / waitFor. */
  hooksUsed: string[];
  /** Rough cognitive complexity per exported symbol. */
  complexityByExport: Record<string, number>;
  /** Native modules that must be jest.mock()'d for the file to even import. */
  requiredMocks: string[];
  loc: number;
}

/** One unit of work the engine will hand to the model. */
export interface Task {
  id: string;
  kind: TaskKind;
  tier: Tier;
  targetPath: string;
  /** Existing test file, if one is already present. */
  existingTestPath: string | null;
  coverage: FileCoverage | null;
  sonarIssues: SonarIssue[];
  facts: FileFacts;
  score: number;
  /** Human-readable justification — shown in the report and the PR body. */
  rationale: string[];
}

/** What the model is required to return, after parsing. */
export interface Generation {
  taskId: string;
  /** Full file contents for a new/replaced test file. */
  testFile: { path: string; contents: string } | null;
  /** Search/replace edits against source files. */
  edits: { path: string; search: string; replace: string }[];
  rationale: string;
  raw: string;
}

export interface VerifyGate {
  name: string;
  passed: boolean;
  detail: string;
  /** Numeric value where the gate has one (coverage %, mutation score). */
  value?: number;
}

export interface VerifyResult {
  taskId: string;
  accepted: boolean;
  attempt: number;
  gates: VerifyGate[];
  /** Fed back into the next generation attempt when accepted === false. */
  feedback: string | null;
  coverageBefore: FileCoverage | null;
  coverageAfter: FileCoverage | null;
  mutationScore: number | null;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(args: {
    system: string;
    messages: ProviderMessage[];
    maxTokens: number;
    temperature: number;
  }): Promise<string>;
}

export interface EngineConfig {
  projectRoot: string;
  /** Globs relative to projectRoot. */
  include: string[];
  exclude: string[];
  testGlob: string;
  /**
   * Where the baseline coverage signal comes from.
   *  'jest' — the engine runs `jest --coverage` itself (small repos)
   *  'lcov' — read an lcov.info your CI already produced (sharded/large repos)
   */
  coverage: {
    source: 'jest' | 'lcov';
    /** Path(s) to lcov.info. Comma-separated, and "dir/*\/lcov.info" is expanded. */
    lcovPath: string | null;
  };
  jest: {
    command: string;
    configPath: string | null;
    /** Cap jest workers. On a 16GB box, jest's default (cpus-1) will OOM a large RN repo. */
    maxWorkers: string | null;
  };
  sonar: {
    enabled: boolean;
    baseUrl: string;
    token: string;
    projectKey: string;
    /** Rules the engine is allowed to auto-fix without human review. */
    autoFixRules: string[];
  };
  /** Path substrings that force Tier C — engine advises, never edits. */
  sensitivePathPatterns: string[];
  provider: {
    kind: 'ollama' | 'anthropic' | 'bedrock' | 'openai-compatible';
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    region?: string;
  };
  gates: {
    minMutationScore: number;
    minBranchCoverageDelta: number;
    maxAttempts: number;
    /** Reject a generation that edits files outside the task's target. */
    enforceScope: boolean;
    /**
     * 'full'    — run the entire suite for the no-regression gate (slow, thorough)
     * 'related' — run only tests related to the touched files (default)
     *
     * For a test-generation task the generation only ADDS a test file, which can
     * only break other tests via shared global state. 'related' catches the
     * realistic cases at a fraction of the cost on a large repo.
     */
    regressionScope: 'full' | 'related';
    /** Stryker parallelism. Each worker is a full jest process — keep low on 16GB. */
    strykerConcurrency: number;
    /**
     * Extra paths Stryker must not copy into its sandbox, on top of the
     * built-in React Native defaults. Getting this wrong is not a slow run —
     * it is a hard crash (EISDIR on ios/Pods framework symlinks).
     */
    strykerIgnorePatterns: string[];
  };
  maxTasks: number;
}
