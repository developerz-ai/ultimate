// The image half of `x deploy --method helm`: which `--set-string` keys the reference becomes, and
// which references are refused before helm sees one. Split from `cmd-deploy.test.ts`, which keeps
// the plan's order and the commands it runs; helm reads its `--set-string` values as data, so a
// reference outside the OCI grammar is a second value, not a typo.

import { describe, expect, test } from 'bun:test';
import { helmImageOverrides, planDeploy } from './cmd-deploy';

/** A helm target as `x deploy` resolves one with no flags: the app's name, no namespace, 15m. */
const HELM = { release: 'demo-app', namespace: undefined, timeout: '15m' } as const;

// `docker/helm/values.yaml` declares `image` as a map and `_helpers.tpl` reads
// `.Values.image.repository`. `--set image=<ref>` overwrote the map with a string, so the
// command that was supposed to ship a new image rendered no workload at all.
describe('unit · the helm override sets the keys the chart reads', () => {
  test('a tagged reference sets repository and tag separately', () => {
    expect(helmImageOverrides('ghcr.io/org/app:1.2.3')).toEqual([
      '--set-string',
      'image.repository=ghcr.io/org/app',
      '--set-string',
      'image.tag=1.2.3',
    ]);
    expect(
      planDeploy('ghcr.io/org/app:1.2.3', 'helm', '/app', HELM).steps[0]?.command,
    ).not.toContain('image=ghcr.io/org/app:1.2.3');
  });

  // The chart's own `default .Chart.AppVersion` is the answer when no tag was asked for, and
  // setting `image.tag=` empty would not have reached it.
  test('a reference with no tag leaves the tag to the chart', () => {
    expect(helmImageOverrides('ghcr.io/org/app')).toEqual([
      '--set-string',
      'image.repository=ghcr.io/org/app',
    ]);
  });

  // A registry port is a colon before the last slash, and reading it as a tag would deploy
  // repository `localhost` at tag `5000/app`.
  test('a registry port is not a tag', () => {
    expect(helmImageOverrides('localhost:5000/app')).toEqual([
      '--set-string',
      'image.repository=localhost:5000/app',
    ]);
    expect(helmImageOverrides('localhost:5000/app:1.2.3')).toEqual([
      '--set-string',
      'image.repository=localhost:5000/app',
      '--set-string',
      'image.tag=1.2.3',
    ]);
  });

  // `--set` types its value: `image.tag=1234567` reached the chart as an int64, and
  // `printf "%s:%s"` rendered `app:%!s(int64=1234567)` into every Deployment and the migrate Job —
  // ImagePullBackOff, and `--wait` blocking for its whole timeout. Any all-digit tag does it: a
  // build number, a date, about one short SHA in 27. `--set-string` never types.
  test('a numeric image tag is passed as a string', () => {
    expect(helmImageOverrides('ghcr.io/org/app:1234567')).toEqual([
      '--set-string',
      'image.repository=ghcr.io/org/app',
      '--set-string',
      'image.tag=1234567',
    ]);
    const command =
      planDeploy('ghcr.io/org/app:20261005', 'helm', '/app', HELM).steps[0]?.command ?? [];
    expect(command[command.indexOf('image.tag=20261005') - 1]).toBe('--set-string');
    expect(command).not.toContain('--set');
  });

  test('a digest is refused with the tagged invocation to run instead', () => {
    expect(() => planDeploy('ghcr.io/org/app@sha256:abc123', 'helm', '/app', HELM)).toThrow(
      /pins a digest/,
    );
  });

  /**
   * Helm splits a `--set-string` argument on `,` and reads `=` as key/value, so an image built
   * from a git ref name — `ghcr.io/o/app,serviceAccount.create=true:1.2` — set a value nobody
   * asked for. Anything outside the OCI reference grammar is refused before helm sees it; the
   * grammar holds none of helm's special characters, so a legal reference never needs escaping.
   */
  test('a reference outside the OCI grammar is refused before it reaches helm', () => {
    for (const image of [
      'ghcr.io/o/app,serviceAccount.create=true:1.2',
      'ghcr.io/o/app:1.2\nimage.pullPolicy=Always',
      'ghcr.io/o/app=x:1.2',
      'ghcr.io/o/my app:1.2',
      'ghcr.io/o/app:{a,b}',
      'ghcr.io/o/app:1\\,2',
      'ghcr.io/O/App:1.2',
      '',
    ]) {
      let thrown: unknown;
      try {
        planDeploy(image, 'helm', '/app', HELM);
      } catch (error) {
        thrown = error;
      }
      expect({ image, code: (thrown as { code?: string } | undefined)?.code }).toEqual({
        image,
        code: 'X_CLI_BAD_FLAG',
      });
      // The fix is pasted: it must not carry the refused value back into a shell.
      expect((thrown as { fix: string }).fix).toBe(
        'x deploy --method helm --image ghcr.io/<org>/<app>:<tag> --json',
      );
    }
  });

  test('every ordinary reference is accepted', () => {
    for (const image of [
      'app',
      'ultimate-app:dev',
      'ghcr.io/org/app:1.2.3',
      'ghcr.io/org/team/app:1234567',
      'localhost:5000/app',
      'localhost:5000/app:1.2.3',
      'registry.example.com:443/org/my_app__x/a-b--c:v1.2.3-rc.1_build',
      'docker.io/library/postgres:16-alpine',
    ]) {
      expect({ image, steps: planDeploy(image, 'helm', '/app', HELM).steps.length }).toEqual({
        image,
        steps: 1,
      });
    }
  });
});
