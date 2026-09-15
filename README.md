# rn-qa-engine

A self-hosted engine that analyses a React Native + TypeScript repo, generates
Jest/RNTL tests and SonarQube fixes with an LLM, and **verifies every generation
against objective gates before a human ever sees it.**

The LLM is a replaceable component. The engine is the verification loop.

---

## The problem this is built around

An LLM pointed at a codebase will produce tests that look right, raise the
coverage number, and assert nothing:

```ts
expect(render(<TransferScreen />)).toBeTruthy();
```

That output is worse than no tests. It lifts the Sonar coverage gate to green
and retires the file from anyone's attention, while catching zero regressions.

The engine's answer is the **mutation-score gate**. Stryker mutates the source
file — flips `>` to `>=`, empties blocks, negates conditionals — and re-runs the
generated tests. Every mutant that survives is a line the tests execute but do
not check.

Measured on the bundled fixture (`fixtures/demo-app`), against the same source file:

| Candidate test file | Branch coverage | Mutation score | Verdict |
|---|---|---|---|
| Coverage theatre (`toBeTruthy` only) | 37% → **97%** | **22%** | **REJECTED** |
| Real assertions | 37% → **100%** | **96%** | **ACCEPTED** |

Coverage cannot tell those apart. Mutation score can. That is the whole thesis.

---

## Pipeline

```
 SIGNAL (deterministic, no model)
   jest --coverage --json   → uncovered lines + specific untaken branch arms
   Sonar /api/issues/search → rule, severity, line (PR-scoped in CI)
   ts-morph                 → exports, props type, hooks, required native mocks,
                              cognitive complexity per export
   git log --since=90.days  → churn
        │
 TRIAGE (rules, no model)
   score = coverageGap × (1 + complexity) × churn
   Tier A  deterministic Sonar rules on an explicit allowlist → auto-fix
   Tier B  tests, complexity refactors                        → human review
   Tier C  auth/crypto/payment paths, Sonar VULNERABILITY     → NEVER edited
        │
 CONTEXT  target source + real exported signatures of its local imports +
          verbatim props type + the exact uncovered line/branch numbers
        │
 GENERATE → <test-file> block, or SEARCH/REPLACE <patch> blocks
        │
 VERIFY (in a throwaway git worktree — never your checkout)
   apply             SEARCH text must match byte-for-byte and uniquely
   scope-guard       touched anything outside the target? reject
   typecheck         tsc --noEmit
   generated-tests   the new tests must pass
   no-regression     the entire existing suite must stay green
   coverage-delta    branch coverage must actually move ≥15pp
   mutation-score    ≥60% of mutants killed
        │
   reject → failure text is fed back as the retry prompt (max 3 attempts)
   accept → unified diff + HTML report → PR for a human to merge
```

Failures are fed back verbatim. A tsc error or a surviving-mutant list is the
highest-signal prompt context available, and it costs nothing to produce.

---

## Install

```bash
npm install && npm run build
npm link            # provides `rnqa`
```

In the **target RN repo**, the mutation gate needs Stryker:

```bash
npm i -D @stryker-mutator/core @stryker-mutator/jest-runner
```

Without it the gate reports `SKIPPED — NOT passed`. It never silently passes.

---

## Usage

### Step 0 — `rnqa doctor` (run this first on any new repo)

```bash
rnqa doctor --project /path/to/rn-app
```

```
  ✓ node >= 20               found v22.22.2
  ✓ git repository           worktree sandboxing available (fast, isolated)
  ✓ typecheck baseline       1 pre-existing type error(s) — these are baselined and ignored
  ✓ jest baseline            1 already-failing test(s) — baselined and ignored
  ✓ coverage report          2 file(s) instrumented
  ✓ stryker (mutation gate)  installed
  ! react-native project     no react-native dependency found
  ✕ llm provider             cannot reach ollama at http://127.0.0.1:11434 — is it running?
```

It reports every reason a run would fail or silently skip a gate, before you
spend an hour finding out the slow way.

### Differential gates

The typecheck and no-regression gates are **differential, not absolute**. Real
repos carry pre-existing type errors and already-failing tests. With absolute
gates every generation would be rejected forever for failures it did not cause,
and the engine would look broken on day one.

So the engine captures the repo's existing failures once, up front, and fails a
generation only for breakage it actually introduced:

```
✓ typecheck:     No new type errors (1 pre-existing, ignored).
✓ no-regression: No new failures (1 already failing before this change, ignored).
```

Verified in both directions — a candidate that introduces a *new* type error is
still rejected:

```
✕ typecheck: 1 NEW type error(s):
  src/.../candidate.test.ts|error TS2322|Type 'string' is not assignable to type 'number'.
```

### Step 1 — `rnqa analyse`

No model is called, so it costs nothing and proves the signal layer:

```bash
rnqa analyse --project /path/to/rn-app
```

```
1. [B] test:src/services/TransferValidator.ts   score 209
     · Branch coverage 37% (11/30), statements 50%.
     · 19 untested branch arm(s); 1 never-invoked function(s).
     · Peak cognitive complexity 30.
     · Changed in 1 commit(s) in the last 90 days.

── ADVISORY (Tier C — engine will not edit these) ────
   · test:src/auth/TokenStore.ts
```

Audit test files — yours or anyone's — with no model involved:

```bash
rnqa verify-file --project /path/to/rn-app \
  --target src/services/TransferValidator.ts \
  --test candidates/real.test.ts --as src/services/__tests__/X.test.ts \
  --report rnqa-report.html
```

Full run:

```bash
rnqa run --project /path/to/rn-app --only src/services --report rnqa-report.html
rnqa run --project /path/to/rn-app --apply     # writes accepted changes
```

---

## Configuration — `rnqa.config.json`

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "jest": { "command": "npx jest", "configPath": null },
  "sonar": {
    "enabled": true,
    "baseUrl": "https://sonar.internal",
    "projectKey": "mobile-app",
    "autoFixRules": ["typescript:S1128", "typescript:S1481", "typescript:S1440"]
  },
  "sensitivePathPatterns": ["auth", "token", "keychain", "payment", "upi", "otp"],
  "provider": {
    "kind": "ollama",
    "model": "qwen2.5-coder:32b",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "gates": {
    "minMutationScore": 60,
    "minBranchCoverageDelta": 15,
    "maxAttempts": 3,
    "enforceScope": true
  },
  "maxTasks": 5
}
```

`SONAR_TOKEN` is read from the environment. Secrets never belong in this file.

### Providers

| kind | Where the code goes | Use when |
|---|---|---|
| `ollama` | nowhere — localhost | default; no egress, no approval needed |
| `openai-compatible` | your gateway | vLLM, LiteLLM, Azure OpenAI, on-prem |
| `anthropic` | Anthropic API | highest quality; needs InfoSec sign-off |
| `bedrock` | — | put LiteLLM in front of Bedrock and use `openai-compatible` |

Swapping providers is a config change. Nothing in triage or verify knows which
model produced the text, which is the point: when the security review lands, the
answer is a one-line edit, not a rewrite.

---

## Deliberate limits

**Tier C is not configurable away by the model.** Files under `auth/`, `crypto/`,
`payment/` and anything Sonar types as a `VULNERABILITY` are filtered out before
the prompt is built. A plausible-looking wrong fix in that code costs more than
the issue it closes.

**The engine never gates a release.** In CI it opens a PR and archives a report.
Anything that can block a developer's build on generated output gets routed
around within a month.

**The engine never edits your working tree unless you pass `--apply`.** All
generation happens in a detached git worktree with `node_modules` symlinked.

**Generated tests describe current behaviour, not correct behaviour.** If the
source has a bug, a high mutation score means the tests faithfully lock in the
bug. This is inherent to generating tests from an implementation, it is not
fixable by a better prompt, and it is the reason Tier B requires human review.

**A skipped gate is not a passed gate.** If Stryker is missing the report says
`SKIPPED — NOT passed` and the score renders as `n/a`.

---

## Repo layout

```
src/
  cli.ts                  analyse | run | verify-file
  config.ts               defaults + thresholds (policy, not code)
  types.ts                every cross-module contract
  signal/coverage.ts      runs the project's own jest; parses istanbul
  signal/sonar.ts         /api/issues/search, PR-scoped, paginated
  context/facts.ts        ts-morph: exports, props, hooks, mocks, complexity
  context/walk.ts         include/exclude globbing
  triage.ts               scoring + tier assignment
  generate/prompts.ts     system prompt + task prompts + retry prompt
  generate/provider.ts    provider adapters + output parsing
  verify/sandbox.ts       throwaway worktree, uniqueness-checked edits
  verify/runner.ts        the gate suite
  verify/mutation.ts      Stryker integration
  report/html.ts          the report shown to reviewers
Jenkinsfile               CI wiring — PR-scoped, non-blocking
rn-jest-setup.example.js  native module mocks for the target RN repo
```

---

## Roadmap, in order of verifiability

1. **Test generation** — objective oracle (tests pass, mutation score is a number). Shipped.
2. **Sonar Tier A** — oracle is re-running the scanner. Shipped, allowlist deliberately short.
3. **Sonar Tier B** (complexity refactors) — only after devs already trust Tier A.
4. **Checkmarx** — advisory output only, never auto-fix. Deliberately last: a high
   false-positive rate means auto-"fixing" writes pointless defensive code into a
   banking app and burns credibility with AppSec in a single PR.
