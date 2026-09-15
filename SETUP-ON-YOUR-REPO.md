# Running this on your own RN repo

Answer to "if I push to GitHub, clone it, and point it at my files — will it work?"
Yes, with the caveats below. Work through this in order.

## 1. Build the engine

```bash
git clone <your-repo> rn-qa-engine
cd rn-qa-engine
npm install
npm run build
npm link          # gives you the `rnqa` command globally
```

Node 20+ is required (global `fetch`, `fs.cpSync`). Check with `node -v`.
If your RN project is pinned to Node 18 via `.nvmrc`, the engine still works —
it shells out to *your* jest, so run `rnqa` under Node 20 and let it invoke the
project's own toolchain.

## 2. Add Stryker to the RN repo (not the engine)

```bash
cd /path/to/your-rn-app
npm i -D @stryker-mutator/core @stryker-mutator/jest-runner
```

Without this the mutation gate reports `SKIPPED — NOT passed`. The engine will
still run, but you lose the one gate that distinguishes real tests from
coverage theatre — which is the entire argument for the project.

## 3. Add `rnqa.config.json` to the RN repo root

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "jest": { "command": "npx jest", "configPath": null },
  "sonar": { "enabled": false },
  "sensitivePathPatterns": ["auth", "token", "credential", "secret", "crypto", "payment"],
  "provider": { "kind": "ollama", "model": "qwen2.5-coder:32b", "baseUrl": "http://127.0.0.1:11434" },
  "maxTasks": 3
}
```

Tune `sensitivePathPatterns` to your repo's actual folder names first. That list
is what keeps the model away from code where a plausible wrong answer is
expensive, and the defaults are generic guesses.

## 4. `rnqa doctor`

```bash
rnqa doctor --project /path/to/your-rn-app
```

Fix every `✕` before going further. A `!` is informational.

## 5. `rnqa analyse` — still no model

```bash
rnqa analyse --project /path/to/your-rn-app
```

This is the first genuinely useful output, and it costs nothing. If the ranking
looks wrong to you, the scoring arithmetic is ~20 readable lines in `triage.ts`.

## 6. `rnqa verify-file` — audit tests you already have

```bash
rnqa verify-file --project /path/to/your-rn-app \
  --target src/screens/SomeScreen.tsx \
  --test src/screens/__tests__/SomeScreen.test.tsx \
  --as src/screens/__tests__/rnqa-candidate.test.tsx
```

Still no model. Run this against a few of your existing test files before you
generate anything. It tells you what your current suite is actually worth.

## 7. Only then, `rnqa run`

```bash
ollama serve &
ollama pull qwen2.5-coder:32b
rnqa run --project /path/to/your-rn-app --only src/utils --report rnqa-report.html
```

Start with `--only` pointed at plain utility modules — no JSX, no navigation, no
native modules. Get a green run there before touching screens.

---

## What will actually break, in likelihood order

**1. The `react-native` jest preset under Stryker.** Least-proven part of the
engine. Stryker's jest runner plus the RN babel transform is a known-fiddly
combination. `disableTypeChecks: true` is already set. If mutation runs hang,
raise `timeoutMS` in `verify/mutation.ts` and try `--only` on a pure-TS module
first to confirm everything else works.

**2. Path aliases.** If your repo uses `@/components/...` via
`babel-plugin-module-resolver` and `tsconfig.paths`, ts-morph resolves them
(it reads your tsconfig) but the generated test may still emit an import jest
cannot resolve. Your `moduleNameMapper` is inherited because the engine shells
out to your jest, so this usually works — but it is the second thing to check.

**3. Wall-clock time.** Each attempt runs your full jest suite, and mutation
testing runs it many more times. On a large RN app budget 10–30 min per file.
Keep `maxTasks` at 3 for the POC. Do not run this on a laptop you need.

**4. `jest-haste-map` warnings** about duplicate module names from the sandbox
worktree. Usually noise. If jest errors rather than warns, add the worktree
prefix (`/tmp/rnqa-*`) to `modulePathIgnorePatterns`.

**5. Windows.** Untested. The sandbox falls back from git worktree to a
directory copy, and symlinking `node_modules` needs developer mode or admin.
WSL2 avoids all of it.

---

## What to expect on the first run

[Likely] the first two or three generations get rejected, and that is the system
working. Read `rnqa-report.html` — it shows rejected generations with the exact
gate that caught them. If you see repeated `mutation-score` rejections, the
model is producing weak assertions and a bigger model is the fix. If you see
repeated `apply` rejections, the model is not reproducing SEARCH blocks
verbatim, which is a known weakness of smaller local models — that is the
signal to try the gateway provider rather than ollama.

Send me the doctor output and the first report and I can tell you which it is.

---

## Running on 16GB hardware with a large repo

If your dev laptops and Jenkins box are 16GB and the repo is ~1GB of source,
the defaults are already tuned for you, but the architecture matters more than
the tuning.

### Do not run the model on the box that runs the gates

Verification is the memory-hungry half, not inference. Stryker spawns full jest
processes, and jest on a large React Native repo is a multi-GB process on its
own. Add a 7B model at ~6GB resident and the machine swaps, which does not fail
loudly — it just makes every run take hours.

So on 16GB, pick one of:

- **Remote provider, local verification.** `provider.kind: "openai-compatible"`
  or `"anthropic"`. The 16GB box does only what it is good at: running jest and
  Stryker. This is the configuration to aim for.
- **Local 7B anyway.** Safe to try, because the gates mean a weak model produces
  *nothing*, not something bad. Expect a low acceptance rate. Useful as evidence
  that a bigger model is needed; not useful as a demo.

### Defaults tuned for this hardware

| Setting | Default | Why |
|---|---|---|
| `jest.maxWorkers` | `"2"` | jest defaults to cpus-1; on 16GB a large RN repo exhausts memory first |
| `gates.strykerConcurrency` | `2` | each worker is a full jest process |
| `gates.regressionScope` | `"related"` | see below |
| `maxTasks` | `3` | keeps a run to a sane wall-clock |

`regressionScope: "related"` runs only tests related to the touched file rather
than the whole suite on every attempt. For a test-generation task the generation
only *adds* a test file, which can break other tests only through shared global
state — so this catches the realistic cases at a fraction of the cost. Set it to
`"full"` for Sonar-fix tasks, which do modify source, or when you have time.

The baseline capture still runs the full suite once per run. That is where the
list of already-failing tests comes from, and it cannot be scoped.

### Disk

Each sandbox is a git worktree with `node_modules` symlinked, not copied, so a
run costs megabytes rather than gigabytes. 500GB is not a constraint. Worktrees
are removed after each task; if a run is killed mid-task, `git worktree prune`
in the app repo cleans up strays.

---

## If your CI already shards jest and produces lcov

A repo large enough to split its test run into shards cannot afford the engine
doing a second, single-process `jest --coverage` over everything just to rank
files. That run is the most expensive thing the engine does, and the answer
already exists in the lcov you upload to SonarQube.

```json
"coverage": {
  "source": "lcov",
  "lcovPath": "coverage/lcov.info"
}
```

Already-merged lcov (the usual case, since Sonar wants one file):

```json
"lcovPath": "coverage/lcov.info"
```

Per-shard files, not yet merged — comma-separated, or a single `*` pattern:

```json
"lcovPath": "coverage/shard-*/lcov.info"
```

Shards are merged by the engine on the rule that a line or branch arm covered in
**any** shard is covered overall.

### What lcov gives up, and why it does not matter here

lcov carries uncovered lines (`DA`), uncovered branch **arms** (`BRDA`) and
never-invoked functions (`FN`/`FNDA`) — everything triage ranks on. It has no
istanbul statement map, so `statements` is approximated by line coverage. Triage
ranks on branches, so the ordering is unaffected. Measured against the same
fixture, the lcov and jest paths produce identical branch numbers (37%, 11/30, 19 untested arms) and differ only on statements (52% vs 50%).

### The coverage-delta gate stays rigorous

lcov and istanbul count differently, so comparing an lcov "before" against an
istanbul "after" would produce a meaningless delta. When `source` is `lcov`, the
engine measures the "before" itself inside the still-pristine sandbox, scoped to
the single file under test with `--collectCoverageFrom` and `--findRelatedTests`.
Both sides of the delta then come from the same instrument. That scoped run is
cheap — it is one file and its related tests, not your suite.

### Files missing from the report

A file that no test imports does not appear in the coverage report at all. The
engine treats a missing entry as **0% covered, ranked highest** — not as 100%
covered. On a large repo these are usually the most valuable targets and the
easiest to overlook, because no coverage dashboard shows them as a problem.
