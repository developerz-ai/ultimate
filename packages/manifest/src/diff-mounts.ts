// A bearer mount's cut in a contract diff. The primitive behind a name stays registered when a name
// leaves a mount, so `diffActions` and `diffQueries` see nothing: only this file sees a held token's
// call turn into a 404. Judged per (scope, name), because a token reaches what its scopes list.

import type { ManifestChange } from './diff-change';
import { index } from './diff-change';
import type { MountFact } from './schema';

export function diffMounts(
  before: readonly MountFact[],
  after: readonly MountFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByPrefix = index(after, (mount) => mount.prefix);
  const beforeByPrefix = index(before, (mount) => mount.prefix);

  for (const mount of before) {
    const path = `mounts.${mount.prefix}`;
    const next = afterByPrefix.get(mount.prefix);
    if (next === undefined) {
      changes.push({ kind: 'breaking', path, detail: 'mount removed; every call under it is 404' });
      continue;
    }
    changes.push(...diffScopes(path, mount.scopes, next.scopes));
  }
  for (const mount of after) {
    if (!beforeByPrefix.has(mount.prefix)) {
      changes.push({ kind: 'additive', path: `mounts.${mount.prefix}`, detail: 'mount added' });
    }
  }
  return changes;
}

type Scopes = MountFact['scopes'];

const scopesHolding = (scopes: Scopes, name: string): readonly string[] =>
  Object.entries(scopes)
    .filter(([, names]) => names.includes(name))
    .map(([scope]) => scope);

function diffScopes(path: string, before: Scopes, after: Scopes): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  for (const [scope, names] of Object.entries(before)) {
    const scopePath = `${path}.scopes.${scope}`;
    const kept = Object.hasOwn(after, scope) ? (after[scope] ?? []) : [];
    if (names.length === 0 && !Object.hasOwn(after, scope)) {
      changes.push({ kind: 'internal', path: scopePath, detail: 'empty scope removed' });
    }
    for (const name of names) {
      if (kept.includes(name)) continue;
      const elsewhere = scopesHolding(after, name);
      changes.push({
        kind: 'breaking',
        path: `${scopePath}.${name}`,
        detail:
          elsewhere.length === 0
            ? 'left the cut; a held token now answers 404'
            : `moved to ${elsewhere.join(', ')}; a token holding ${scope} now answers 404`,
      });
    }
  }
  for (const [scope, names] of Object.entries(after)) {
    const scopePath = `${path}.scopes.${scope}`;
    const known = Object.hasOwn(before, scope);
    if (!known) changes.push({ kind: 'additive', path: scopePath, detail: 'scope added' });
    for (const name of names) {
      if (known && (before[scope] ?? []).includes(name)) continue;
      changes.push({ kind: 'additive', path: `${scopePath}.${name}`, detail: 'added to the cut' });
    }
  }
  return changes;
}
