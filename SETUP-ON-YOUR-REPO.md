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
  "sensitivePathPatterns": ["auth", "token", "keychain", "payment", "upi", "otp", "mpin"],
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
