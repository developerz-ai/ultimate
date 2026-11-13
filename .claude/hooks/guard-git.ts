#!/usr/bin/env bun
// The git half of guard-destructive-git.sh: refuse a Bash command that would discard uncommitted
// work. A tokenizer, not a regex over the flattened string — quoting, comments, redirects,
// heredocs, `cd`, `git -C` and git's global options all change what a command touches. Scoped to
// checkouts of this repository: another repository's work is not this guard's to refuse.

// why: resolving `cd`/`-C` targets against a cwd; Bun ships no path API.
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

type Simple = readonly string[];

const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n']);

/** Split a shell command into simple commands of quote-stripped words. Best effort, never throws. */
export function simpleCommands(source: string): Simple[] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let skipNext = false; // the word after a redirect operator is its target, not an argument
  const heredocs: { tag: string; strip: boolean }[] = [];
  const endWord = (): void => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\\') {
      if (source.charAt(i + 1) !== '\n') {
        word += source.charAt(i + 1);
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = source.indexOf("'", i + 1);
      const end = close === -1 ? source.length : close;
      word += source.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < source.length && source.charAt(i) !== '"') {
        if (source.charAt(i) === '\\' && '"\\$`\n'.includes(source.charAt(i + 1))) i++;
        word += source.charAt(i);
        i++;
      }
      inWord = true;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < source.length && source.charAt(i) !== '\n') i++;
      continue;
    }
    if (c === '<' && source.startsWith('<<', i) && !source.startsWith('<<<', i)) {
      endWord();
      i += 2;
      const strip = source.charAt(i) === '-';
      if (strip) i++;
      while (source.charAt(i) === ' ' || source.charAt(i) === '\t') i++;
      let tag = '';
      while (i < source.length && !/[\s;&|<>()]/.test(source.charAt(i))) {
        if (!`'"\\`.includes(source.charAt(i))) tag += source.charAt(i);
        i++;
      }
      heredocs.push({ tag, strip });
      continue;
    }
    if (c === '>' || c === '<') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      i++;
      while ('<>&|'.includes(source.charAt(i)) && i < source.length) i++;
      skipNext = true;
      continue;
    }
    if (c === '&' && source.charAt(i + 1) === '>') {
      endWord();
      i += 2;
      if (source.charAt(i) === '>') i++;
      skipNext = true;
      continue;
    }
    if (SEPARATORS.has(c)) {
      endCommand();
      i++;
      if (c === '\n' && heredocs.length > 0) {
        // Skip each pending heredoc body: its lines are data, never commands.
        for (const { tag, strip } of heredocs.splice(0)) {
          while (i < source.length) {
            const eol = source.indexOf('\n', i);
            const line = source.slice(i, eol === -1 ? source.length : eol);
            i = eol === -1 ? source.length : eol + 1;
            if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
          }
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return commands;
}

/** git's global options that take a separate value, e.g. `git -C dir`, `git -c k=v`. */
const GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
]);

/** Options that point git at a repository other than the one the directory says. */
const REPOINTING = ['--git-dir', '--work-tree'];

/**
 * Whether `dir` sits in a checkout of THIS repository: the nearest ancestor holding `.git` also
 * holds this guard. A clone of this repository counts (a hive may work in one); an unrelated
 * repository, or no repository at all, does not.
 */
export function inThisRepo(dir: string, exists: (path: string) => boolean): boolean {
  let at = dir;
  for (;;) {
    if (exists(join(at, '.git'))) return exists(join(at, '.claude', 'hooks', 'guard-git.ts'));
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

const deny = (reason: string): Verdict => ({ ok: false, reason });
const ALLOW: Verdict = { ok: true };

/** Whether `token` names something on disk from `cwd`, or is pathspec syntax rather than a ref. */
function isPathish(token: string, cwd: string, exists: (path: string) => boolean): boolean {
  if (token.startsWith(':') || /[*?[]/.test(token)) return true;
  return exists(isAbsolute(token) ? token : resolve(cwd, token));
}

function judgeCheckout(args: Simple, cwd: string, exists: (p: string) => boolean): Verdict {
  const rest = [...args];
  const snapshot = rest[0]?.startsWith('refs/snapshots/') === true;
  if (snapshot) return ALLOW; // the documented recovery: git checkout refs/snapshots/<n> -- <path>
  for (let k = 0; k < rest.length; k++) {
    const token = rest[k] ?? '';
    if (token === '--') {
      return k + 1 < rest.length ? deny('git checkout of pathspecs after --') : ALLOW;
    }
    if (token === '-f' || token === '--force' || token === '--discard-changes') {
      return deny('a forced checkout');
    }
    if (token.startsWith('--pathspec-from-file')) return deny('git checkout --pathspec-from-file');
    if (token === '-b' || token === '-B' || token === '--orphan') {
      k++; // the new branch's name is not a path, even when a directory shares it
      continue;
    }
    if (token.startsWith('-')) continue;
    if (isPathish(token, cwd, exists))
      return deny(`git checkout over a working-tree path (${token})`);
  }
  return ALLOW;
}

function judgeGit(
  words: Simple,
  cwd: string,
  exists: (p: string) => boolean,
  repointed: boolean,
): Verdict {
  let dir = cwd;
  let k = 1;
  let elsewhere = repointed;
  while (k < words.length && (words[k] ?? '').startsWith('-')) {
    const opt = words[k] ?? '';
    if (REPOINTING.some((name) => opt === name || opt.startsWith(`${name}=`))) elsewhere = true;
    if (GLOBAL_WITH_VALUE.has(opt)) {
      if (opt === '-C') dir = resolve(dir, words[k + 1] ?? '.');
      k += 2;
    } else k++;
  }
  // A re-pointed git is judged as if it were this checkout: failing closed costs a prompt, failing
  // open costs a tree.
  if (!elsewhere && !inThisRepo(dir, exists)) return ALLOW;
  const sub = words[k];
  const args = words.slice(k + 1);
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a));
  switch (sub) {
    case 'checkout':
      return judgeCheckout(args, dir, exists);
    case 'checkout-index':
      return deny('git checkout-index writes the index over the working tree');
    case 'switch':
      return has('-f', '--force', '--discard-changes') ? deny('a forced branch switch') : ALLOW;
    case 'restore': {
      const staged = has('--staged', '-S');
      const worktree = has('--worktree', '-W');
      return staged && !worktree ? ALLOW : deny('git restore');
    }
    case 'reset':
      return has('--hard', '--merge', '--keep') ? deny('git reset --hard/--merge/--keep') : ALLOW;
    case 'clean':
      return deny('git clean');
    case 'stash':
      // `list` and `show` only read; every other verb (and a bare `git stash`) moves work.
      return args[0] === 'list' || args[0] === 'show'
        ? ALLOW
        : deny('git stash (forbidden in this repo; `git stash list` and `git stash show` read)');
    default:
      return ALLOW;
  }
}

/** The verdict on one Bash command, run from `cwd`. `exists` is injectable for tests. */
export function judge(
  command: string,
  cwd: string,
  exists: (path: string) => boolean,
  home = Bun.env.HOME ?? cwd,
): Verdict {
  let here = cwd;
  for (const raw of simpleCommands(command)) {
    let words = raw;
    let repointed = false;
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
      if (/^GIT_(DIR|WORK_TREE)=/.test(words[0] ?? '')) repointed = true;
      words = words.slice(1); // FOO=1 git …
    }
    if (words[0] === 'env' || words[0] === 'command' || words[0] === 'exec') words = words.slice(1);
    const head = words[0];
    if (head === 'cd') {
      const target = words[1];
      here = target === undefined || target === '~' ? home : resolve(here, target);
      continue;
    }
    if (head === 'git' || head?.endsWith('/git') === true) {
      const verdict = judgeGit(words, here, exists, repointed);
      if (!verdict.ok) return verdict;
    }
  }
  return ALLOW;
}

if (import.meta.main) {
  const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    tool_input?: { command?: unknown };
    cwd?: unknown;
  };
  const command = typeof record.tool_input?.command === 'string' ? record.tool_input.command : '';
  const cwd =
    typeof record.cwd === 'string' ? record.cwd : (Bun.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  // why: a directory counts as a path too, and Bun.file().exists() answers false for one.
  const { existsSync } = await import('node:fs');
  const verdict = judge(command, cwd, existsSync);
  if (!verdict.ok) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
}
