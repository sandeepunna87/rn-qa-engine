import * as path from 'path';
import { EngineConfig, SonarIssue } from '../types';

interface RawSonarIssue {
  key: string;
  rule: string;
  severity: string;
  type: string;
  message: string;
  component: string; // "projectKey:src/foo/Bar.tsx"
  line?: number;
  effort?: string; // "15min", "1h30min"
}

function parseEffort(effort: string | undefined): number {
  if (!effort) return 0;
  const h = /(\d+)h/.exec(effort);
  const m = /(\d+)min/.exec(effort);
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

/**
 * Pulls open issues for the project. `pullRequest` scopes to a PR so CI runs
 * only see what the change introduced — running the engine over an entire
 * legacy repo produces an unreviewable pile of PRs, which is how these
 * initiatives die.
 */
export async function fetchSonarIssues(
  config: EngineConfig,
  opts: { pullRequest?: string; branch?: string } = {}
): Promise<SonarIssue[]> {
  if (!config.sonar.enabled) return [];
  const { baseUrl, token, projectKey } = config.sonar;
  if (!baseUrl || !token || !projectKey) {
    throw new Error('sonar.enabled is true but baseUrl/token/projectKey are incomplete.');
  }

  const out: SonarIssue[] = [];
  let page = 1;
  const pageSize = 500;

  for (;;) {
    const url = new URL('/api/issues/search', baseUrl);
    url.searchParams.set('componentKeys', projectKey);
    url.searchParams.set('statuses', 'OPEN,CONFIRMED,REOPENED');
    url.searchParams.set('ps', String(pageSize));
    url.searchParams.set('p', String(page));
    if (opts.pullRequest) url.searchParams.set('pullRequest', opts.pullRequest);
    else if (opts.branch) url.searchParams.set('branch', opts.branch);
    // A developer wants the issues THEY introduced, not the repo's backlog.
    if (config.sonar.newCodeOnly) url.searchParams.set('inNewCodePeriod', 'true');

    const res = await fetch(url, {
      headers: {
        // Sonar accepts the token as the basic-auth username with empty password.
        Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`SonarQube ${res.status} ${res.statusText} for ${url.pathname}`);
    }
    const body = (await res.json()) as { issues: RawSonarIssue[]; total: number };

    for (const i of body.issues) {
      const rel = i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component;
      out.push({
        key: i.key,
        rule: i.rule,
        severity: i.severity as SonarIssue['severity'],
        type: i.type as SonarIssue['type'],
        message: i.message,
        path: path.resolve(config.projectRoot, rel),
        line: i.line ?? 0,
        effortMinutes: parseEffort(i.effort),
      });
    }

    if (page * pageSize >= body.total || body.issues.length === 0) break;
    page++;
    // Sonar caps deep pagination at 10k results; stop well before it errors.
    if (page * pageSize > 10000) break;
  }
  return out;
}

export function groupIssuesByPath(issues: SonarIssue[]): Map<string, SonarIssue[]> {
  const map = new Map<string, SonarIssue[]>();
  for (const i of issues) {
    const list = map.get(i.path);
    if (list) list.push(i);
    else map.set(i.path, [i]);
  }
  return map;
}
