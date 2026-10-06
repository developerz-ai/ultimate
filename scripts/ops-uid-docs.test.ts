// The ops-uid doc rule: a uid `docs/ops/` states is the one its image runs — `RUNTIME_UID` for a
// scaffolded app, `docker/helm/values.yaml`'s for this repo — and the drift it was built for (the
// scaffold said to run 1000 in its chart while the chart ran 65532) is a finding.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { RUNTIME_UID } from '../packages/cli/src/templates/scaffold-helm';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkUidClaims,
  opsUidFindings,
  readUidDocs,
  repoChartUid,
  uidClaims,
} from './ops-uid-docs';

// Reads the real tree: the repo-scan budget, as every scripts test that does.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const FACTS = { scaffold: 1000, repo: 65532 };
const findingsFor = (line: string) => checkUidClaims(uidClaims('docs/ops/x.md', line), FACTS);

describe('a uid claim is attributed by the clause that states it', () => {
  test('each image keeps its own number, on one line', () => {
    const line =
      "| `runAsUser` | `65532` in this repo's chart; `1000` (plus `fsGroup: 1000`) in the chart `x new` writes |";
    const claims = uidClaims('docs/ops/x.md', line);
    expect(claims.map((claim) => `${claim.owner}:${claim.uid}`)).toEqual([
      'repo:65532',
      'scaffold:1000',
      'scaffold:1000',
    ]);
    expect(checkUidClaims(claims, FACTS)).toEqual([]);
  });

  test("the drift: the scaffold's chart said to run the repo's uid", () => {
    const [finding] = findingsFor('the chart `x new` writes runs `runAsUser: 65532`');
    expect(finding?.code).toBe('X_DOC_UID_STALE');
    expect(finding?.at).toBe('docs/ops/x.md:1');
    expect(finding?.fix).toBe(
      'bun run scripts/ops-uid-docs.ts --json   # then edit docs/ops/x.md:1 to state 1000',
    );
  });

  test('a uid neither image runs is stale even when the clause names no image', () => {
    expect(findingsFor('pods run as `runAsUser: 1001`').map((one) => one.code)).toEqual([
      'X_DOC_UID_STALE',
    ]);
  });

  test('dates, versions, sizes and fenced lines are not uids', () => {
    expect(
      uidClaims(
        'docs/ops/x.md',
        [
          'this repo runs nonroot, 184 MB, `As of 2026-10`, bun 1.4.2, uid 2026-08',
          '```yaml',
          'runAsUser: 4242',
          '```',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test("the repo chart's uid is podSecurityContext's runAsUser, not any other", () => {
    const yaml =
      'other:\n  runAsUser: 7\npodSecurityContext:\n  runAsNonRoot: true\n  runAsUser: 65532\n';
    expect(repoChartUid(yaml)).toBe(65532);
    expect(repoChartUid('podSecurityContext:\n  runAsNonRoot: true\n')).toBeUndefined();
  });
});

describe('against this repo', () => {
  test('every uid docs/ops states is its image’s, over claims about both images', async () => {
    const root = repoRoot();
    const { claims, repo } = await readUidDocs(root);
    expect(repo).toBeDefined();
    expect(repo).not.toBe(RUNTIME_UID);
    const owners = claims.map((claim) => claim.owner);
    expect(owners).toContain('repo');
    expect(owners).toContain('scaffold');
    expect(await opsUidFindings(root)).toEqual([]);
  });
});
