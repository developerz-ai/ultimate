// Whether a rebuilt generation can be served by the process that built it. `x dev` mounts its route
// table ONCE, at boot (`dev-route-table.ts`): a page, action, query, channel, admin or mount that
// appeared or vanished in a save is a 404 (or a dead handler) until a new process mounts it. A load
// finding that appeared or cleared is the same question, asked of the modules that did not import.

import type { Manifest } from '@ultimat3/manifest';
import type { MessageKey } from './messages';
import { msg } from './messages';
import type { Finding } from './output';

/** One thing the boot mounted: `key` says whether it is the same thing, `label` names it. */
interface Mounted {
  readonly kind: 'route' | 'action' | 'query' | 'channel' | 'admin' | 'mount';
  readonly key: string;
  readonly label: string;
}

/** Why a generation needs a new process — and exactly what moved, for the restart line. */
export type Remount =
  | {
      readonly kind: 'surface';
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | {
      readonly kind: 'findings';
      readonly failing: readonly string[];
      readonly loads: readonly string[];
    };

/** What the boot mounted from `manifest`. Never the handlers' bodies: an edited body reloads. */
function mountedOf(manifest: Manifest): readonly Mounted[] {
  const named = (kind: Mounted['kind'], name: string): Mounted => ({
    kind,
    key: name,
    label: name,
  });
  return [
    ...manifest.routes.map((route): Mounted => {
      const key = `${route.url} (${route.render}${route.surface === undefined ? '' : `, ${route.surface}`})`;
      return { kind: 'route', key, label: key };
    }),
    ...manifest.actions.map((action) => named('action', action.name)),
    ...manifest.queries.map((query) => named('query', query.name)),
    ...(manifest.channels ?? []).map((channel) => named('channel', channel.name)),
    ...(manifest.admin ?? []).map(
      (admin): Mounted => ({ kind: 'admin', key: JSON.stringify(admin), label: admin.basePath }),
    ),
    ...(manifest.mounts ?? []).map(
      (mount): Mounted => ({ kind: 'mount', key: JSON.stringify(mount), label: mount.prefix }),
    ),
  ];
}

/**
 * Each kind's catalog word, spelled out so every key is a literal the catalog is checked against.
 * A switch, not a table: `item.kind` is read off a mount, and a computed table read can answer an
 * `Object.prototype` member (`bun run proto-index`); the switch is exhaustive by its return type.
 */
function kindWord(kind: Mounted['kind']): MessageKey {
  switch (kind) {
    case 'route':
      return 'cli.dev.mounted.route';
    case 'action':
      return 'cli.dev.mounted.action';
    case 'query':
      return 'cli.dev.mounted.query';
    case 'channel':
      return 'cli.dev.mounted.channel';
    case 'admin':
      return 'cli.dev.mounted.admin';
    case 'mount':
      return 'cli.dev.mounted.mount';
  }
}

const mountedId = (item: Mounted): string => `${item.kind}\u0000${item.key}`;

/** `before` less `after`, as the catalog's words: `route /fresh (ssr, app)`. */
const missingFrom = (before: readonly Mounted[], after: readonly Mounted[]): string[] => {
  const kept = new Set(after.map(mountedId));
  return before
    .filter((item) => !kept.has(mountedId(item)))
    .map((item) => msg(kindWord(item.kind), { name: item.label }));
};

const findingKey = (finding: Finding): string =>
  [finding.code, finding.at ?? '', finding.cause].join('\u0000');

/** Where each finding of `before` that `after` no longer holds was raised, deduplicated. */
const clearedAt = (before: readonly Finding[], after: readonly Finding[]): string[] => {
  const kept = new Set(after.map(findingKey));
  const gone = before.filter((finding) => !kept.has(findingKey(finding)));
  return [...new Set(gone.map((finding) => finding.at ?? finding.code))];
};

export interface Generation {
  readonly manifest: Manifest;
  readonly findings: readonly Finding[];
}

/**
 * `surface` first: it is the cause of the 404 a fixed load failure left behind. A finding that
 * appeared or cleared restarts too, so the ready line a fresh child prints is the generation's own
 * verdict — red while a module will not import, green the save after it does. Order-insensitive:
 * a reordered scan is not a different answer.
 */
export function remountReason(before: Generation, after: Generation): Remount | undefined {
  const was = mountedOf(before.manifest);
  const now = mountedOf(after.manifest);
  const added = missingFrom(now, was);
  const removed = missingFrom(was, now);
  if (added.length > 0 || removed.length > 0) return { kind: 'surface', added, removed };
  const failing = clearedAt(after.findings, before.findings);
  const loads = clearedAt(before.findings, after.findings);
  if (failing.length > 0 || loads.length > 0) return { kind: 'findings', failing, loads };
  return undefined;
}

/** What moved, one comma-separated list: `route /fresh (ssr, app) added, query feed removed`. */
function changes(remount: Remount): string {
  const words =
    remount.kind === 'surface'
      ? [
          ...remount.added.map((what) => msg('cli.dev.change.added', { what })),
          ...remount.removed.map((what) => msg('cli.dev.change.removed', { what })),
        ]
      : [
          ...remount.failing.map((file) => msg('cli.dev.change.failing', { file })),
          ...remount.loads.map((file) => msg('cli.dev.change.loads', { file })),
        ];
  return words.join(', ');
}

/** The restart line `x dev` prints for a generation it cannot mount — true to why. */
export function remountLine(remount: Remount, file: string): string {
  const key = remount.kind === 'surface' ? 'cli.dev.restartSurface' : 'cli.dev.restartFindings';
  return msg(key, { file, changes: changes(remount) });
}

/** `/_x`'s finding when nothing supervises the process (an embedded `startDev()`, no `onRestart`). */
export function remountFinding(remount: Remount, file: string): Finding {
  return {
    code: 'X_DEV_RESTART_REQUIRED',
    cause:
      remount.kind === 'surface'
        ? `the save to ${file} changed what x dev mounts (${changes(remount)}) — the route table is built once, at boot, so this process answers 404 for what was added`
        : `the save to ${file} changed which modules load (${changes(remount)}) — a module that failed to import is served only by a new process`,
    fix: 'x stop && x dev',
    at: file,
  };
}
