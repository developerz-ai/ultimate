// The two declaration registries: `policies` (a permission, where it is enforced) and
// `errorCodes` (a code, the package that owns it). Both are keyed by a string a consumer matches
// on — a permission it grants, a code it branches on — so losing an entry is breaking and the
// metadata beside it is internal.

import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { ErrorCodeFact, PolicyFact } from './schema';

export function diffPolicies(
  before: readonly PolicyFact[],
  after: readonly PolicyFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (p) => p.permission);
  const beforeByName = index(before, (p) => p.permission);

  for (const policy of before) {
    const next = afterByName.get(policy.permission);
    const path = `policies.${policy.permission}`;
    if (next === undefined) {
      // The rule this permission names is enforced nowhere now; an actor holding the grant is
      // the only thing left that still believes in it.
      changes.push({ kind: 'breaking', path, detail: 'policy removed' });
      continue;
    }
    changes.push(
      ...diffScalar(
        'internal',
        `${path}.description`,
        policy.description,
        next.description,
        (from, to) => `description "${from}" -> "${to}"`,
      ),
    );
    // Same direction as an operation's permissions: a NEW enforcement site refuses callers that
    // reached that surface yesterday; one dropped widens access and is reported, never fatal.
    changes.push(...diffEnforcedIn(path, policy.enforcedIn, next.enforcedIn));
  }
  for (const policy of after) {
    if (!beforeByName.has(policy.permission)) {
      changes.push({
        kind: 'additive',
        path: `policies.${policy.permission}`,
        detail: 'policy added',
      });
    }
  }
  return changes;
}

function diffEnforcedIn(
  path: string,
  before: readonly string[],
  after: readonly string[],
): readonly ManifestChange[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after
      .filter((site) => !beforeSet.has(site))
      .map((site) => ({
        kind: 'breaking' as const,
        path: `${path}.enforcedIn.${site}`,
        detail: 'now enforced here; callers that reached this surface are refused',
      })),
    ...before
      .filter((site) => !afterSet.has(site))
      .map((site) => ({
        kind: 'additive' as const,
        path: `${path}.enforcedIn.${site}`,
        detail: 'no longer enforced here; access widened',
      })),
  ];
}

export function diffErrorCodes(
  before: readonly ErrorCodeFact[],
  after: readonly ErrorCodeFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByCode = index(after, (e) => e.code);
  const beforeByCode = index(before, (e) => e.code);

  for (const fact of before) {
    const next = afterByCode.get(fact.code);
    const path = `errorCodes.${fact.code}`;
    if (next === undefined) {
      // A code is stable forever once shipped — every `catch` matching on it, every runbook and
      // every `x errors explain` argument stops resolving the moment it leaves the file.
      changes.push({ kind: 'breaking', path, detail: 'error code removed' });
      continue;
    }
    // Which package declares it is a fact about the framework, not about the caller: the code
    // string is what anyone matches on, and it did not move.
    changes.push(
      ...diffScalar(
        'internal',
        `${path}.package`,
        fact.package,
        next.package,
        (from, to) => `owner ${from} -> ${to}`,
      ),
    );
  }
  for (const fact of after) {
    if (!beforeByCode.has(fact.code)) {
      changes.push({
        kind: 'additive',
        path: `errorCodes.${fact.code}`,
        detail: 'error code added',
      });
    }
  }
  return changes;
}
