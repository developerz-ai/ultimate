#!/usr/bin/env bun
// Attaches the OIDC trusted publisher to every published package, and verifies it stayed attached.
// A package with no trusted publisher silently falls back to token auth on release day, which is
// the failure this repo removed NPM_TOKEN to avoid.
//
// `--check` is an OPERATOR command, not a `x verify` step, and cannot become one: every call needs
// an npm session carrying 2FA plus a fresh OTP (`NPM_CONFIG_OTP`), which CI has no way to supply —
// and supplying it would reintroduce the standing credential OIDC exists to remove. The header said
// "a gate step, not a courtesy" until 2.0.0; it was never wired into `scripts/verify.ts`, and the
// claim was the kind this repo treats as a defect. Run it before a release, read the findings.
//
//   bun run scripts/trust-publishers.ts --check [--json]   # verify, read-only
//   bun run scripts/trust-publishers.ts [--dry-run] [--json]

import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';

/** The GitHub org carries a hyphen; the npm scope does not. Both are correct — see PUBLISHING.md. */
export const DEFAULT_REPO = 'developerz-ai/ultimate';
export const DEFAULT_WORKFLOW = 'release.yml';

/**
 * The environment `release.yml`'s publish job declares. A trusted publisher configured WITHOUT one
 * accepts an OIDC token minted by any environment, which silently undoes the `npm-publish`
 * environment's reviewer and `v*` tag rules — the only controls that can hold a job carrying
 * `id-token: write` until a human approves it. Blank here is not a smaller version of the rule;
 * it is the rule switched off.
 */
export const DEFAULT_ENVIRONMENT = 'npm-publish';

/**
 * `npm trust` shipped in npm 12. Bun's bundled npm and Node 22's are both older, and an older npm
 * reports it as an unknown command — so the runner is pinned by version rather than inherited.
 */
export const NPM = ['npx', '-y', 'npm@12', ...[]] as const;

export interface TrustTarget {
  readonly name: string;
  readonly tier: number;
}

export interface TrustOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly state: 'configured' | 'already' | 'missing' | 'denied' | 'failed' | 'skipped';
  readonly detail: string;
}

/** `npm trust github <pkg> --file … --repo … --allow-publish -y`, as one argv. */
export const trustArgs = (
  name: string,
  repo: string,
  workflow: string,
  environment: string = DEFAULT_ENVIRONMENT,
): readonly string[] => [
  ...NPM,
  'trust',
  'github',
  name,
  '--file',
  workflow,
  '--repo',
  repo,
  ...(environment ? (['--environment', environment] as const) : []),
  // Configurations created after 2026-05-20 must name at least one allowed action explicitly.
  '--allow-publish',
  '-y',
];

export const listArgs = (name: string): readonly string[] => [
  ...NPM,
  'trust',
  'list',
  name,
  '--json',
];

/**
 * npm refuses this call for a granular access token that bypasses two-factor auth, which is the
 * whole point: attaching a publisher is an account-level trust change. Recognising it separately
 * turns an opaque 403 into the one command that fixes it.
 */
export const isTwoFactorRefusal = (output: string): boolean =>
  /bypass two-factor|bypass2fa|EOTP|one-time pass/i.test(output);

export const isUnknownCommand = (output: string): boolean =>
  /Unknown command: "trust"/i.test(output);

/** A configured publisher is any entry naming this repo's release workflow. */
export function hasPublisher(
  raw: string,
  repo: string,
  workflow: string,
  environment: string = DEFAULT_ENVIRONMENT,
): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    // `npm trust list <pkg> --json` answers a BARE OBJECT for a single publisher, not an array and
    // not `{ trustedPublishers: [...] }` — so reading only the two collection shapes made this
    // return false for every configured package, and `--check` could never pass.
    const bag = parsed as {
      readonly trustedPublishers?: readonly unknown[];
      readonly repository?: string;
    } | null;
    const rows = Array.isArray(parsed)
      ? parsed
      : (bag?.trustedPublishers ?? (bag?.repository === undefined ? [] : [bag]));
    return rows.some((row) => {
      const entry = row as {
        readonly repository?: string;
        readonly workflow?: string;
        readonly file?: string;
        readonly environment?: string;
        readonly environment_name?: string;
      };
      // The environment is part of the identity, not a detail: a publisher carrying none accepts a
      // token from ANY environment, so treating it as configured would report the hole as closed.
      const env = entry.environment ?? entry.environment_name ?? '';
      return (
        entry.repository === repo &&
        (entry.workflow ?? entry.file) === workflow &&
        env === environment
      );
    });
  } catch {
    return false;
  }
}

export function findingFor(outcome: TrustOutcome): Finding | undefined {
  if (outcome.ok) return undefined;
  if (outcome.state === 'denied') {
    return {
      code: 'X_TRUST_2FA_REQUIRED',
      at: outcome.name,
      cause: `npm refused the trust change: ${outcome.detail}`,
      fix: 'npm login   # then re-run: bun run scripts/trust-publishers.ts',
    };
  }
  if (outcome.state === 'missing') {
    return {
      code: 'X_TRUST_PUBLISHER_MISSING',
      at: outcome.name,
      cause: `${outcome.name} has no trusted publisher for ${DEFAULT_REPO}/${DEFAULT_WORKFLOW}`,
      fix: 'bun run scripts/trust-publishers.ts',
    };
  }
  return {
    code: 'X_TRUST_PUBLISHER_FAILED',
    at: outcome.name,
    cause: `could not configure ${outcome.name}: ${outcome.detail}`,
    fix: 'npm login && bun run scripts/trust-publishers.ts --json',
  };
}

async function main(): Promise<never> {
  const args = parseScriptArgs(process.argv.slice(2));
  const json = args.json;
  const check = flagBool(args, 'check');
  const dryRun = flagBool(args, 'dry-run');
  const repo = flagString(args, 'repo') ?? DEFAULT_REPO;
  const workflow = flagString(args, 'workflow') ?? DEFAULT_WORKFLOW;
  const environment = flagString(args, 'environment') ?? DEFAULT_ENVIRONMENT;
  const root = repoRoot();

  const targets = publishOrder(await listWorkspaces(root));
  const outcomes: TrustOutcome[] = [];

  for (const target of targets) {
    if (dryRun) {
      outcomes.push({ name: target.name, ok: true, state: 'skipped', detail: 'dry run' });
      continue;
    }
    const listed = await run(listArgs(target.name), { cwd: root });
    if (isUnknownCommand(listed.output)) {
      report(
        {
          ok: false,
          script: 'trust-publishers',
          summary: 'npm is too old for `npm trust`',
          findings: [
            {
              code: 'X_TRUST_NPM_TOO_OLD',
              cause: 'the npm on PATH has no `trust` subcommand; it shipped in npm 12',
              fix: 'npm install -g npm@12',
            },
          ],
        },
        json,
      );
    }
    if (listed.ok && hasPublisher(listed.output, repo, workflow, environment)) {
      outcomes.push({ name: target.name, ok: true, state: 'already', detail: 'publisher present' });
      continue;
    }
    if (check) {
      outcomes.push({ name: target.name, ok: false, state: 'missing', detail: 'no publisher' });
      continue;
    }
    const attached = await run(trustArgs(target.name, repo, workflow, environment), { cwd: root });
    if (attached.ok) {
      outcomes.push({
        name: target.name,
        ok: true,
        state: 'configured',
        detail: `${repo}/${workflow}`,
      });
      continue;
    }
    const denied = isTwoFactorRefusal(attached.output);
    outcomes.push({
      name: target.name,
      ok: false,
      state: denied ? 'denied' : 'failed',
      detail: attached.output.split('\n').slice(-1)[0] ?? `exit ${attached.code}`,
    });
  }

  const findings = outcomes
    .map(findingFor)
    .filter((finding): finding is Finding => finding !== undefined);
  const good = outcomes.filter((outcome) => outcome.ok).length;
  report(
    {
      ok: findings.length === 0,
      script: 'trust-publishers',
      summary: `${good}/${outcomes.length} packages trust ${repo}/${workflow}`,
      findings,
      data: { repo, workflow, outcomes },
    },
    json,
  );
}

if (import.meta.main) await main();
