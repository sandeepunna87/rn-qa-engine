# Security notes

## Keep this repository private

Once you configure this engine for a real application, several things in it
become useful reconnaissance for anyone attacking that application:

- `sensitivePathPatterns` in your real `rnqa.config.json` is a map of where the
  application keeps its authentication, credential and payment code.
- The `Jenkinsfile` carries internal hostnames and credential IDs.
- Generated reports embed source diffs.

Nothing here is a vulnerability on its own. Together they shorten the path for
someone who is looking. Use a private repository for any fork carrying real
configuration, and prefer your organisation's internal SCM over personal
accounts.

## Never commit

- `rnqa.config.json` with your real internal hostnames — commit
  `rnqa.config.example.json` instead and keep the real one untracked.
- `SONAR_TOKEN`, LLM gateway keys, or any credential. These are read from the
  environment at load time, which is why `config.ts` resolves them there and not
  from the config file.
- `rnqa-report.html` or anything under `.rnqa/` — reports embed source code and
  diffs of the application. Both are gitignored; keep it that way.
- Coverage or mutation JSON. Same reason.

## What the engine sends to a model

Everything in the prompt: the target file's source, the exported signatures of
its local imports, its props type, and its coverage gaps. Assume the provider
sees the whole file.

This is the single fact to put in front of InfoSec. With
`provider.kind: "ollama"` nothing leaves the host, which is why that is the
default. Any other provider is a data-egress decision and needs a sign-off, not
a config change made quietly.

## What the engine will not touch

Files matching `sensitivePathPatterns`, and anything SonarQube types as a
`VULNERABILITY`, are filtered out in `triage.ts` **before the prompt is built**.
The model never receives that source. This is enforced in code, not requested in
the prompt, so it cannot be argued away by a model that decides it knows better.

Review that list against your repo's real folder names before the first run. The
shipped defaults are generic guesses and will not match your layout.
