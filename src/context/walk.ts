import * as fs from 'fs';
import * as path from 'path';

/** Minimal glob → RegExp. Supports **, *, ? — enough for include/exclude lists. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more path segments
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.rnqa',
  'ios',
  'android',
  'build',
  'dist',
  'coverage',
  '.expo',
]);

export function findCandidates(
  projectRoot: string,
  include: string[],
  exclude: string[]
): string[] {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(projectRoot, full).split(path.sep).join('/');
      if (!inc.some((r) => r.test(rel))) continue;
      if (exc.some((r) => r.test(rel))) continue;
      out.push(full);
    }
  };

  walk(projectRoot);
  return out.sort();
}
