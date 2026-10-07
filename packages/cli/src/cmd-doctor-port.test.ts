// Which port `x doctor` probes and what it says about `APP_URL`: the port `x dev` would bind —
// `--port`, then `PORT`, then 3000 — and the public origin that port is served under.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from './app-root';
import type { DoctorProbe } from './cmd-doctor';
import { doctorCommand, doctorPort, probeFor, runDoctor } from './cmd-doctor';
import { devPortFor } from './dev-port';
import { appUrlFindings } from './doctor-app-url';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const argsFor = (argv: readonly string[]) => parseArgs(['doctor', ...argv], [doctorCommand.spec]);

describe('unit · x doctor probes the port x dev binds', () => {
  test('PORT moves the probe exactly as it moves x dev, and --port still wins', () => {
    const env = { PORT: '4000' };
    expect(doctorPort(argsFor([]), env)).toBe(4000);
    expect(doctorPort(argsFor([]), env)).toBe(devPortFor(parseArgs(['dev'], SPECS), env));
    expect(doctorPort(argsFor(['--port', '5000']), env)).toBe(5000);
    expect(doctorPort(argsFor([]), {})).toBe(3000);
  });

  // A declared default is indistinguishable from a caller's value, so `PORT` could never be read.
  test('the spec declares no default for --port', () => {
    const port = doctorCommand.spec.flags?.find((flag) => flag.name === 'port');
    expect(port?.default).toBeUndefined();
  });
});

describe('unit · x doctor reads APP_URL against the port it probes', () => {
  test('unset or blank is no finding: x dev serves without one', () => {
    expect(appUrlFindings(undefined, 3000)).toEqual([]);
    expect(appUrlFindings('  ', 3000)).toEqual([]);
  });

  test('an APP_URL no browser origin can match is the boot refusal, carried whole', () => {
    for (const raw of ['localhost:3000', 'ftp://example.com', 'not a url']) {
      const findings = appUrlFindings(raw, 3000);
      expect([raw, findings.map((finding) => finding.code)]).toEqual([raw, ['X_CONFIG_INVALID']]);
    }
  });

  test('a loopback APP_URL on another port than x dev serves is named, with the line to paste', () => {
    const findings = appUrlFindings('http://localhost:3000', 4000);
    expect(findings.map((finding) => finding.code)).toEqual(['X_APP_URL_PORT_MISMATCH']);
    expect(findings[0]?.fix).toBe('export APP_URL=http://localhost:4000');
    // Every loopback spelling is the same machine; the default port of the scheme counts.
    expect(appUrlFindings('http://127.0.0.1', 3000)[0]?.fix).toBe(
      'export APP_URL=http://127.0.0.1:3000',
    );
    expect(appUrlFindings('http://[::1]:3001', 3000)).toHaveLength(1);
  });

  test('a matching loopback origin, or a public one, is not judged against the dev port', () => {
    expect(appUrlFindings('http://localhost:4000/', 4000)).toEqual([]);
    expect(appUrlFindings('https://www.example.com', 4000)).toEqual([]);
  });
});

describe('unit · runDoctor asks the APP_URL rule of the port it probed', () => {
  /** The healthy app `cmd-doctor.test.ts` describes, on port 4000 with a laptop APP_URL. */
  const probe = (appUrl: string | undefined): DoctorProbe => ({
    bunVersion: REQUIRED_BUN,
    root: '/app',
    port: 4000,
    appUrl,
    frameworkFindings: [],
    exists: () => true,
    portFree: async () => true,
    database: async () => null,
    embeddedDatabase: async () => ({ selected: true, resolved: true }),
    drift: async () => [],
    snapshots: async () => [],
    offlineFallback: async () => ({
      fallback: '/offline',
      routes: [{ path: '/offline', surface: 'site' }],
    }),
    sealedKeys: async () => ({ columns: [], keys: undefined }),
    authStorage: async () => ({ unsealedMfaSecrets: 0, retiredTables: [] }),
  });

  test('a stale laptop APP_URL is a finding; the matching one is not', async () => {
    const codes = async (appUrl: string | undefined) =>
      (await runDoctor(probe(appUrl))).map((finding) => finding.code);
    expect(await codes('http://localhost:3000')).toEqual(['X_APP_URL_PORT_MISMATCH']);
    expect(await codes('http://localhost:4000')).toEqual([]);
    expect(await codes(undefined)).toEqual([]);
  });
});

// `doctorPort` read `PORT` from the injected env while the probe read `APP_URL` from the host's,
// so the two halves of one rule came from two environments.
describe('unit · the probe reads APP_URL from the same env the port came from', () => {
  test('an injected APP_URL is the one judged', () => {
    const env = { APP_URL: 'http://localhost:3999', PORT: '4000' };
    expect(probeFor('/', REQUIRED_BUN, 4000, env).appUrl).toBe('http://localhost:3999');
    expect(probeFor('/', REQUIRED_BUN, 4000, {}).appUrl).toBeUndefined();
  });
});
