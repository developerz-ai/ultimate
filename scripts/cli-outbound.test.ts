// The enforcement half of `scripts/cli-outbound.ts`: an analytics URL in a fixture is refused, the
// reserved names pass, a stale allowance is its own finding, and the real tree is clean — which is
// what makes "`x` sends nothing anywhere" a build error on `unit` as well as on `boundaries`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { stripComments } from '../packages/core/src/source-mask';
import type { OutboundSource } from './cli-outbound';
import {
  CLI_OUTBOUND_ALLOWLIST,
  cliOutboundFindings,
  cliOutboundResult,
  isReservedHost,
  outboundHosts,
} from './cli-outbound';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'packages/cli/src/cmd-doctor.ts';
const file = (source: string, path = AT): OutboundSource => ({
  path,
  stripped: stripComments(source),
});
const hosts = (source: string, path = AT): readonly string[] =>
  outboundHosts(file(source, path)).map((site) => site.host);

describe('a host literal in the CLI', () => {
  test('a fetch to an analytics host is found, scheme and case folded', () => {
    expect(
      hosts("await fetch('https://Telemetry.Acme.io/v1/events', { method: 'POST' });"),
    ).toEqual(['telemetry.acme.io']);
    expect(hosts('const ws = new WebSocket(`wss://collect.example.org.evil.net/x`);')).toEqual([
      'collect.example.org.evil.net',
    ]);
  });

  test('a host only a comment names is not a literal the process can reach', () => {
    expect(hosts('// see https://telemetry.acme.io for why\nconst a = 1;')).toEqual([]);
  });

  test('reserved names are exempt: .invalid, .test, .example, example.*, localhost, loopback', () => {
    for (const host of [
      'route.invalid',
      'example.test',
      'app.example',
      'example.com',
      'app.example.com',
      'www.example.net',
      'localhost',
      'feat.localhost',
      '127.0.0.1',
      '[::1]',
      '0.0.0.0',
    ]) {
      expect(isReservedHost(host)).toBe(true);
    }
    for (const host of ['examples.com', 'example.com.evil.net', 'localhost.evil.net', 'acme.io']) {
      expect(isReservedHost(host)).toBe(false);
    }
  });

  test('a test file is a fixture and never scanned', () => {
    expect(
      hosts("fetch('https://telemetry.acme.io')", 'packages/cli/src/cmd-doctor.test.ts'),
    ).toEqual([]);
  });
});

describe('the verdict', () => {
  const allowed = Object.keys(CLI_OUTBOUND_ALLOWLIST).map((host, index) =>
    file(`const u${String(index)} = 'https://${host}/x';`, `packages/cli/src/a${String(index)}.ts`),
  );

  test('an unlisted host is X_CLI_OUTBOUND_UNDECLARED, naming the file, the line and the allowlist', () => {
    const result = cliOutboundResult([
      ...allowed,
      file("\n\nawait fetch('https://telemetry.acme.io/v1', { body });"),
    ]);
    expect(result.ok).toBe(false);
    const [finding] = result.findings ?? [];
    expect(finding?.code).toBe('X_CLI_OUTBOUND_UNDECLARED');
    expect(finding?.at).toBe(`${AT}:3`);
    expect(finding?.cause).toContain('telemetry.acme.io');
    expect(finding?.fix).toContain('scripts/cli-outbound.ts');
    expect(finding?.fix).toContain('bun run scripts/cli-outbound.ts --json');
  });

  test('every allowed host present and nothing else: green', () => {
    expect(cliOutboundResult(allowed)).toMatchObject({ ok: true, findings: [] });
  });

  test('an allowance no file uses any more is X_CLI_OUTBOUND_ALLOWANCE_STALE', () => {
    const result = cliOutboundResult(allowed.slice(1));
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_CLI_OUTBOUND_ALLOWANCE_STALE',
    ]);
    expect(result.findings?.[0]?.cause).toContain(Object.keys(CLI_OUTBOUND_ALLOWLIST)[0] ?? '');
  });

  test('every allowance states its why', () => {
    for (const why of Object.values(CLI_OUTBOUND_ALLOWLIST)) expect(why.length).toBeGreaterThan(20);
  });
});

describe('a root of its own', () => {
  test('a fixture tree with an analytics call fails through the host check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-outbound-'));
    try {
      await Bun.write(
        join(root, 'packages/cli/src/track.ts'),
        "export const track = () => fetch('https://events.acme-analytics.io/i');\n",
      );
      const findings = await cliOutboundFindings(root);
      expect(findings.map((finding) => finding.code)).toContain('X_CLI_OUTBOUND_UNDECLARED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the real tree', () => {
  test('the CLI reaches no host outside the allowlist, and every row is still used', async () => {
    expect(await cliOutboundFindings(repoRoot())).toEqual([]);
  });
});
