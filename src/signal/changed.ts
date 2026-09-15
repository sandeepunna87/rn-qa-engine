import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Works out which files THIS developer changed.
 *
 * The repo-wide ranking answers "where is our worst debt?" — a quarterly
 * question, answered by a batch job. A developer finishing a feature has a
 * different question: "is what I just wrote covered, and does it trip Sonar?"
 * That question is scoped to a diff, not to a repo, and it recurs every time
 * anyone touches the file.
 *
 * Includes committed work since the base ref, plus staged and unstaged edits,
 * because "I just wrote this" usually means it is not committed yet.
 */

export interface ChangedFiles {
  files: string[];
  baseRef: string;
  breakdown: { committed: number; staged: number; unstaged: number; untracked: number };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Probing for candidate base refs is expected to fail several times.
    // Let those failures be silent rather than printing git's fatal: lines.
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Finds the branch this work forked from, so we compare against the right point. */
export function resolveBaseRef(projectRoot: string, explicit?: string): string {
  if (explicit) return explicit;

  for (const candidate of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master']) {
    const mergeBase = tryGit(['merge-base', 'HEAD', candidate], projectRoot);
    if (mergeBase) return candidate;
  }
  // Single-branch repo with no remote: compare against the previous commit.
  return tryGit(['rev-parse', 'HEAD~1'], projectRoot) ? 'HEAD~1' : 'HEAD';
}

export function findChangedFiles(projectRoot: string, explicitBase?: string): ChangedFiles {
  const baseRef = resolveBaseRef(projectRoot, explicitBase);
  const seen = new Set<string>();
  const breakdown = { committed: 0, staged: 0, unstaged: 0, untracked: 0 };

  const add = (rel: string, bucket: keyof typeof breakdown): void => {
    if (!rel) return;
    const abs = path.resolve(projectRoot, rel);
    // A deleted file has nothing to test. Skip rather than fail later.
    if (!fs.existsSync(abs)) return;
    if (!seen.has(abs)) breakdown[bucket]++;
    seen.add(abs);
  };

  // Committed on this branch since it diverged from the base.
  const mergeBase = tryGit(['merge-base', 'HEAD', baseRef], projectRoot) ?? baseRef;
  const committed = tryGit(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}...HEAD`], projectRoot);
  if (committed) committed.split('\n').forEach((f) => add(f.trim(), 'committed'));

  // Staged but not committed.
  const staged = tryGit(['diff', '--name-only', '--diff-filter=ACMR', '--cached'], projectRoot);
  if (staged) staged.split('\n').forEach((f) => add(f.trim(), 'staged'));

  // Edited but not staged.
  const unstaged = tryGit(['diff', '--name-only', '--diff-filter=ACMR'], projectRoot);
  if (unstaged) unstaged.split('\n').forEach((f) => add(f.trim(), 'unstaged'));

  // Brand-new files the developer has not added yet — the most common case for
  // "I just wrote a feature" and the easiest one to miss.
  const untracked = tryGit(['ls-files', '--others', '--exclude-standard'], projectRoot);
  if (untracked) untracked.split('\n').forEach((f) => add(f.trim(), 'untracked'));

  return { files: [...seen].sort(), baseRef, breakdown };
}

/** Line numbers this developer added or modified, per file. Used to focus the prompt. */
export function changedLines(projectRoot: string, baseRef: string, absPath: string): number[] {
  const rel = path.relative(projectRoot, absPath);
  const mergeBase = tryGit(['merge-base', 'HEAD', baseRef], projectRoot) ?? baseRef;

  const out = new Set<number>();
  for (const args of [
    ['diff', '-U0', `${mergeBase}...HEAD`, '--', rel],
    ['diff', '-U0', '--cached', '--', rel],
    ['diff', '-U0', '--', rel],
  ]) {
    const diff = tryGit(args, projectRoot);
    if (!diff) continue;
    for (const line of diff.split('\n')) {
      // @@ -old,count +new,count @@
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
      for (let i = 0; i < count; i++) out.add(start + i);
    }
  }
  return [...out].sort((a, b) => a - b);
}
