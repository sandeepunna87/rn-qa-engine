import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Generated code is applied to a throwaway copy of the repo, never the working
 * tree. A git worktree is used when available (cheap, shares the object store and
 * node_modules via symlink); otherwise we fall back to a hardlink copy.
 *
 * Nothing the model produces can touch the developer's checkout until a human
 * merges the PR.
 */
export class Sandbox {
  readonly root: string;
  private isWorktree = false;

  private constructor(root: string, isWorktree: boolean) {
    this.root = root;
    this.isWorktree = isWorktree;
  }

  static create(projectRoot: string, label: string): Sandbox {
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `rnqa-${safeLabel}-`));
    fs.rmSync(dest, { recursive: true, force: true });

    let isWorktree = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      execFileSync('git', ['worktree', 'add', '--detach', dest, 'HEAD'], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      isWorktree = true;
    } catch {
      fs.cpSync(projectRoot, dest, {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|\.git|\.rnqa|android[\\/]build|ios[\\/]build)$/.test(src),
      });
    }

    // node_modules is symlinked, never copied — copying it is the single slowest
    // thing a tool like this can do.
    const nm = path.join(dest, 'node_modules');
    const srcNm = path.join(projectRoot, 'node_modules');
    if (!fs.existsSync(nm) && fs.existsSync(srcNm)) {
      try {
        fs.symlinkSync(srcNm, nm, 'junction');
      } catch {
        /* Windows without privileges — jest will resolve up the tree anyway. */
      }
    }

    return new Sandbox(dest, isWorktree);
  }

  abs(relOrAbs: string): string {
    return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(this.root, relOrAbs);
  }

  /** Map a path from the real repo into this sandbox. */
  mirror(projectRoot: string, absPathInProject: string): string {
    return path.join(this.root, path.relative(projectRoot, absPathInProject));
  }

  writeFile(relPath: string, contents: string): void {
    const full = this.abs(relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }

  readFile(relPath: string): string {
    return fs.readFileSync(this.abs(relPath), 'utf8');
  }

  exists(relPath: string): boolean {
    return fs.existsSync(this.abs(relPath));
  }

  /**
   * Applies a search/replace edit. Fails loudly when SEARCH is absent or
   * ambiguous — a fuzzy match here is how an engine silently corrupts a file.
   */
  applyEdit(relPath: string, search: string, replace: string): void {
    const full = this.abs(relPath);
    if (!fs.existsSync(full)) throw new Error(`Edit target does not exist: ${relPath}`);
    const original = fs.readFileSync(full, 'utf8');
    const first = original.indexOf(search);
    if (first === -1) {
      throw new Error(`SEARCH block not found verbatim in ${relPath}`);
    }
    if (original.indexOf(search, first + 1) !== -1) {
      throw new Error(`SEARCH block is ambiguous (matches more than once) in ${relPath}`);
    }
    fs.writeFileSync(full, original.slice(0, first) + replace + original.slice(first + search.length));
  }

  /** Paths changed relative to HEAD — the basis of the scope guard. */
  changedFiles(): string[] {
    if (!this.isWorktree) return [];
    try {
      const out = execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: this.root,
        encoding: 'utf8',
      });
      return out
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  unifiedDiff(): string {
    if (!this.isWorktree) return '';
    try {
      execFileSync('git', ['add', '-A'], { cwd: this.root, stdio: 'ignore' });
      return execFileSync('git', ['diff', '--cached'], {
        cwd: this.root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  }

  destroy(projectRoot: string): void {
    try {
      if (this.isWorktree) {
        execFileSync('git', ['worktree', 'remove', '--force', this.root], {
          cwd: projectRoot,
          stdio: 'ignore',
        });
        return;
      }
    } catch {
      /* fall through to rm */
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
