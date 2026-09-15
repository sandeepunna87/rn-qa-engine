import { branchPct } from '../signal/coverage';
import { EngineConfig, Generation, Task, VerifyResult } from '../types';

export interface RunRecord {
  task: Task;
  generation: Generation | null;
  result: VerifyResult | null;
  attempts: number;
  diff: string;
  error?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const TIER_LABEL: Record<string, string> = {
  A: 'Tier A · auto-fix',
  B: 'Tier B · review required',
  C: 'Tier C · advisory only',
};

/**
 * The pitch artefact. Deliberately shows the REJECTED generations too — a report
 * that only shows wins reads as a demo; one that shows the loop catching bad
 * output reads as an engine.
 */
export function renderReport(
  config: EngineConfig,
  records: RunRecord[],
  advisory: Task[],
  meta: { provider: string; durationMs: number; startedAt: string }
): string {
  const accepted = records.filter((r) => r.result?.accepted);
  const rejected = records.filter((r) => r.result && !r.result.accepted);

  const covDeltas = accepted
    .map((r) => branchPct(r.result!.coverageAfter) - branchPct(r.result!.coverageBefore))
    .filter((n) => Number.isFinite(n));
  const avgDelta = covDeltas.length ? covDeltas.reduce((a, b) => a + b, 0) / covDeltas.length : 0;
  const mutScores = accepted.map((r) => r.result!.mutationScore).filter((n): n is number => n !== null);
  const avgMut = mutScores.length ? mutScores.reduce((a, b) => a + b, 0) / mutScores.length : null;

  const card = (label: string, value: string, sub: string): string => `
    <div class="card">
      <div class="card-label">${esc(label)}</div>
      <div class="card-value">${esc(value)}</div>
      <div class="card-sub">${esc(sub)}</div>
    </div>`;

  const gateRow = (r: RunRecord): string =>
    (r.result?.gates ?? [])
      .map(
        (g) => `<li class="gate ${g.passed ? 'pass' : 'fail'}">
          <span class="gate-name">${g.passed ? '✓' : '✕'} ${esc(g.name)}</span>
          <span class="gate-detail">${esc(g.detail)}</span>
        </li>`
      )
      .join('');

  const recordBlock = (r: RunRecord): string => {
    const res = r.result;
    const status = res?.accepted ? 'accepted' : 'rejected';
    return `
    <details class="record ${status}" ${res?.accepted ? '' : 'open'}>
      <summary>
        <span class="badge ${status}">${status}</span>
        <code>${esc(r.task.id)}</code>
        <span class="tier">${esc(TIER_LABEL[r.task.tier] ?? r.task.tier)}</span>
        <span class="attempts">${r.attempts} attempt(s)</span>
      </summary>
      <div class="record-body">
        <h4>Why this file was selected</h4>
        <ul class="rationale">${r.task.rationale.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h4>Verification gates</h4>
        <ul class="gates">${gateRow(r)}</ul>
        ${r.generation?.rationale ? `<h4>Model rationale</h4><p class="model-rationale">${esc(r.generation.rationale)}</p>` : ''}
        ${r.error ? `<h4>Error</h4><pre class="err">${esc(r.error)}</pre>` : ''}
        ${r.diff ? `<h4>Diff</h4><pre class="diff">${esc(r.diff.slice(0, 20000))}</pre>` : ''}
      </div>
    </details>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RN QA Engine — run report</title>
<style>
  :root{--bg:#fbfbfa;--fg:#1a1a18;--muted:#6b6b66;--line:#e3e3df;--pass:#1f7a4d;--fail:#b03030;--accent:#2b5cd9;}
  @media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececea;--muted:#9a9a95;--line:#2c2c32;--pass:#4fbf85;--fail:#e07070;--accent:#7aa2f7;}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;padding:32px 20px 80px}
  .wrap{max-width:1020px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--muted);font-size:13px;margin-bottom:28px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:32px}
  .card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:transparent}
  .card-label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .card-value{font-size:28px;font-weight:600;letter-spacing:-.02em;margin:4px 0 2px}
  .card-sub{font-size:12px;color:var(--muted)}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:32px 0 12px;font-weight:600}
  .record{border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden}
  .record summary{padding:12px 16px;cursor:pointer;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:99px}
  .badge.accepted{background:color-mix(in srgb,var(--pass) 18%,transparent);color:var(--pass)}
  .badge.rejected{background:color-mix(in srgb,var(--fail) 18%,transparent);color:var(--fail)}
  .tier,.attempts{font-size:12px;color:var(--muted)}
  code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
  .record-body{padding:0 16px 16px;border-top:1px solid var(--line)}
  h4{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px}
  ul{margin:0;padding-left:18px}
  .gates{list-style:none;padding:0}
  .gate{display:flex;gap:10px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13px;flex-wrap:wrap}
  .gate-name{font-weight:600;min-width:180px}
  .gate.pass .gate-name{color:var(--pass)}
  .gate.fail .gate-name{color:var(--fail)}
  .gate-detail{color:var(--muted);flex:1;min-width:200px}
  pre{background:color-mix(in srgb,var(--fg) 5%,transparent);padding:12px;border-radius:8px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace;max-height:420px}
  .model-rationale{font-size:13.5px;color:var(--muted);margin:0}
  .advisory{border-left:3px solid var(--accent);padding:10px 14px;margin-bottom:8px;background:color-mix(in srgb,var(--accent) 6%,transparent);border-radius:0 8px 8px 0}
  .advisory code{font-weight:600}
  .note{font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:12px 14px;margin-top:8px}
</style></head><body><div class="wrap">

<h1>React Native QA Engine — run report</h1>
<div class="sub">${esc(config.projectRoot)} · provider <code>${esc(meta.provider)}</code> · started ${esc(meta.startedAt)} · ${(meta.durationMs / 1000).toFixed(0)}s</div>

<div class="cards">
  ${card('Accepted', String(accepted.length), `of ${records.length} generations attempted`)}
  ${card('Rejected by gates', String(rejected.length), 'caught before review — not merged')}
  ${card('Avg branch coverage Δ', `+${avgDelta.toFixed(0)}pp`, `threshold ≥${config.gates.minBranchCoverageDelta}pp`)}
  ${card('Avg mutation score', avgMut === null ? 'n/a' : `${avgMut.toFixed(0)}%`, `threshold ≥${config.gates.minMutationScore}%`)}
  ${card('Advisory (Tier C)', String(advisory.length), 'engine reports, never edits')}
</div>

<h2>Generations</h2>
${records.length ? records.map(recordBlock).join('') : '<p class="note">No executable tasks in this run.</p>'}

<h2>Tier C — advisory only, no code written</h2>
${
  advisory.length
    ? advisory
        .map(
          (t) => `<div class="advisory"><code>${esc(t.id)}</code><br>${t.rationale.map(esc).join('<br>')}</div>`
        )
        .join('')
    : '<p class="note">No sensitive-path or vulnerability findings in scope.</p>'
}
<p class="note"><strong>Why these are excluded:</strong> files matching ${esc(config.sensitivePathPatterns.slice(0, 6).join(', '))}… and anything Sonar typed as a VULNERABILITY are never edited by the engine. A plausible-looking wrong fix in auth, crypto or payment code costs more than the issue it closes. The engine surfaces them for a human and stops.</p>

</div></body></html>`;
}
