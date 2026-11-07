// An app's own websocket upgrade, made a build error: `deviceSocket()` is the one way an app serves
// a long-lived socket, and a hand-rolled `server.upgrade(` or `Bun.serve({ websocket })` skips the
// token check before the handshake, the per-actor cap, the beat, the frame limit and the drain.
// Pure over the `boundaries` step's one read; masked, so a comment or a string never matches.

import { ERROR_DOCS_URL, maskLiterals } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import { commentSafe } from './comment-safe';
import type { Finding } from './output';

/** `Bun.serve(` — its argument is read for a `websocket` key. */
const SERVE = /\bBun\s*\.\s*serve\s*\(/g;
/** A `websocket` KEY in an object literal: `websocket: x`, or the shorthand `{ websocket }`. */
const WEBSOCKET_KEY = /\bwebsocket\s*[:,}]/;
/**
 * Bun's upgrade, by the names its two halves carry: the server (`server.upgrade(`, `srv.upgrade(`)
 * or the request it takes (`x.upgrade(request`). `plans.upgrade(org)` is somebody's business.
 */
const UPGRADE = /\b(?:server|srv)\s*\.\s*upgrade\s*\(|\.\s*upgrade\s*\(\s*(?:req|request)\b/g;
/** An inline handler set — `websocket: {` — whatever server it is handed to. */
const HANDLERS = /\bwebsocket\s*:\s*\{/g;

/** The index closing the `(` at `open`, or the end of the text. Exact over `maskLiterals` output. */
function closeOf(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1;
    else if (masked[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return masked.length;
}

/** Where each hand-rolled upgrade starts, as an offset into `masked`. */
function handRolledAt(masked: string): readonly number[] {
  const at: number[] = [];
  for (const match of masked.matchAll(SERVE)) {
    const open = match.index + match[0].length - 1;
    if (WEBSOCKET_KEY.test(masked.slice(open, closeOf(masked, open)))) at.push(match.index);
  }
  for (const pattern of [UPGRADE, HANDLERS]) {
    for (const match of masked.matchAll(pattern)) at.push(match.index);
  }
  return at;
}

/** 1-based line of `offset`; `maskLiterals` keeps every newline, so the count is the source's. */
const lineOf = (masked: string, offset: number): number =>
  masked.slice(0, offset).split('\n').length;

/** One `X_SOCKET_HAND_ROLLED` per app file that serves a socket itself, at its first line. */
export function handRolledSocketFindings(files: readonly SourceFile[]): readonly Finding[] {
  return files.flatMap(({ path, source }): Finding[] => {
    if (!source.includes('upgrade') && !source.includes('websocket')) return [];
    const masked = maskLiterals(source);
    const first = Math.min(...handRolledAt(masked));
    if (!Number.isFinite(first)) return [];
    const line = lineOf(masked, first);
    return [
      {
        code: 'X_SOCKET_HAND_ROLLED',
        cause: `${path}:${String(line)} upgrades a websocket itself, so the token check before the handshake, the per-actor cap, the heartbeat, the frame limit and the drain are the app's to remember — and the boot never serves it on the web listener`,
        fix: `x verify --only boundaries --json   # in ${commentSafe(path)}, delete the upgrade and declare the socket: export const link = deviceSocket({ path, resolveToken, onFrame }) from @ultimat3/realtime/server`,
        docs: ERROR_DOCS_URL,
        at: path,
        meta: { line },
      },
    ];
  });
}
