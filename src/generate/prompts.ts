import * as fs from 'fs';
import * as path from 'path';
import { detectConventions } from '../context/conventions';
import { EngineConfig, Task } from '../types';
import { testPathFor } from '../triage';

export const SYSTEM_PROMPT = `You are a React Native + TypeScript test and remediation engine.

Hard rules:
- Output ONLY the tagged blocks described in the user message. No prose outside them.
- Never invent an import, prop, export or module path. Use ONLY symbols given to you.
- Never change observable behaviour of the source file in a test-generation task.
- Tests must assert real outcomes (rendered text, called args, thrown errors, state
  transitions). A test whose only assertion is toBeTruthy/toBeDefined is a failure.
- Cover the SPECIFIC uncovered lines and branch arms listed. Each branch arm needs its
  own test case driving that arm.
- Match the repo's own testing conventions exactly as given under RENDERING and
  the EXAMPLE TEST. Never import a library that is not already used there.
- Never leave floating promises; flush async work the way the example does.
- Mock every native module listed under REQUIRED MOCKS, at the top of the file.`;

/**
 * The source, numbered. A flat line cap silently hid the exact code the model
 * was asked to cover — a 524-line screen component truncated at 400 lost the
 * region containing several of its uncovered branch arms. So: send the whole
 * file when it fits, and when it does not, keep the head (imports, types,
 * component signature) plus a window around every line the task is about.
 */
function readSnippet(absPath: string, focusLines: number[] = [], maxLines = 900): string {
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const n = (i: number): string => `${String(i + 1).padStart(4)} | ${lines[i]}`;

  if (lines.length <= maxLines) return lines.map((_, i) => n(i)).join('\n');

  const keep = new Set<number>();
  for (let i = 0; i < Math.min(120, lines.length); i++) keep.add(i);
  for (const line of focusLines) {
    for (let i = Math.max(0, line - 26); i < Math.min(lines.length, line + 14); i++) keep.add(i);
  }

  const out: string[] = [];
  let lastKept = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (lastKept !== -1 && i > lastKept + 1) {
      out.push(`     … ${i - lastKept - 1} lines omitted (not relevant to this task) …`);
    }
    out.push(n(i));
    lastKept = i;
  }
  return out.join('\n');
}

function importTypeContext(task: Task, projectRoot: string, budgetChars = 6000): string {
  const parts: string[] = [];
  let used = 0;
  for (const imp of task.facts.localImports) {
    if (!imp.resolvedPath || !fs.existsSync(imp.resolvedPath)) continue;
    const text = fs.readFileSync(imp.resolvedPath, 'utf8');
    // Only the shape matters: exported signatures, not bodies.
    const signatures = text
      .split('\n')
      .filter((l) => /^\s*export\s+(type|interface|const|function|class|default|enum)/.test(l))
      .join('\n');
    if (!signatures) continue;
    const block = `--- ${path.relative(projectRoot, imp.resolvedPath)} (exports only) ---\n${signatures}`;
    if (used + block.length > budgetChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n') || '(no local imports with exported signatures)';
}

export function buildTestPrompt(config: EngineConfig, task: Task): string {
  const rel = path.relative(config.projectRoot, task.targetPath);
  const conventions = detectConventions(config.projectRoot, task.facts.isComponent);
  const cov = task.coverage;
  const outPath = path.relative(config.projectRoot, testPathFor(config, task.targetPath));

  const existing = task.existingTestPath
    ? `\n## EXISTING TEST FILE (${path.relative(config.projectRoot, task.existingTestPath)})\nExtend this file. Keep every existing test intact.\n\`\`\`tsx\n${fs.readFileSync(task.existingTestPath, 'utf8')}\n\`\`\`\n`
    : '';

  return `# TASK: generate Jest + React Native Testing Library tests

## TARGET FILE: ${rel}
\`\`\`tsx
${readSnippet(task.targetPath, [
  ...(cov?.uncoveredLines ?? []),
  ...(cov?.uncoveredBranchLines ?? []),
])}
\`\`\`

## EXPORTS YOU MAY IMPORT
${task.facts.exports.join(', ') || '(none detected)'}

## PROPS TYPE (verbatim from source)
${task.facts.propsTypeText ?? '(none)'}

## REQUIRED MOCKS (jest.mock these or the import will throw)
${task.facts.requiredMocks.length ? task.facts.requiredMocks.map((m) => `- ${m}`).join('\n') : '(none)'}

## HOOKS USED (drive these; flush async with waitFor)
${task.facts.hooksUsed.join(', ') || '(none)'}

## LOCAL IMPORT SIGNATURES (real types — do not invent shapes)
${importTypeContext(task, config.projectRoot)}

## RENDERING — this repo's actual setup, not a general convention
${conventions.renderingGuidance}

## EXAMPLE TEST FROM THIS REPO — match this style, these providers, these imports
${
  conventions.exemplarText
    ? `(${path.relative(config.projectRoot, conventions.exemplarPath as string)})\n\`\`\`tsx\n${conventions.exemplarText}\n\`\`\``
    : '(no existing test found — follow the RENDERING guidance above)'
}

## COVERAGE GAP YOU MUST CLOSE
- Uncovered lines: ${cov?.uncoveredLines.join(', ') || '(none reported — file may be untested entirely)'}
- Uncovered branch arms on lines: ${cov?.uncoveredBranchLines.join(', ') || '(none)'}
- Never-invoked functions: ${cov?.uncoveredFunctions.join(', ') || '(none)'}
${existing}
## OUTPUT FORMAT (exactly this, nothing else)
<test-file path="${outPath}">
// complete, runnable file contents
</test-file>
<rationale>
One short paragraph: which branch arm each test drives, and why the assertions
would fail if the logic were wrong.
</rationale>`;
}

export function buildSonarFixPrompt(config: EngineConfig, task: Task): string {
  const rel = path.relative(config.projectRoot, task.targetPath);
  const issueList = task.sonarIssues
    .map((i) => `- [${i.severity}] ${i.rule} @ line ${i.line}: ${i.message}`)
    .join('\n');

  return `# TASK: fix SonarQube issues without changing behaviour

## TARGET FILE: ${rel}
\`\`\`tsx
${readSnippet(task.targetPath, task.sonarIssues.map((i) => i.line))}
\`\`\`

## ISSUES TO RESOLVE
${issueList}

## CONSTRAINTS
- Behaviour must be identical. The existing test suite will be run against your edit
  and any failure rejects it outright.
- Edit ONLY ${rel}. Touching any other file rejects the whole generation.
- Do not add dependencies.
- If an issue cannot be fixed without a behaviour change, emit no edit for it and say
  so in <rationale>. Leaving it unfixed is correct; guessing is not.

## OUTPUT FORMAT (exactly this, nothing else)
For each edit, a block whose SEARCH text appears EXACTLY ONCE in the file, verbatim,
including indentation:

<patch path="${rel}">
<<<<<<< SEARCH
(exact existing lines)
=======
(replacement lines)
>>>>>>> REPLACE
</patch>

Repeat <patch> per edit. Then:
<rationale>
Which rule each edit clears and why behaviour is preserved.
</rationale>`;
}

/** Retry prompt: the verify loop's failure output is the highest-signal context there is. */
export function buildRetryPrompt(feedback: string): string {
  return `Your previous output was REJECTED by the verification loop.

${feedback}

Fix the specific failure above. Re-emit the COMPLETE output in the same tagged format.
Do not apologise, do not explain outside <rationale>.`;
}
