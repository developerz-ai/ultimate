// `x deploy` — containers only. The framework knows about images, roles and a registry; it does
// not know the name of a cloud, a KV store or an edge runtime (axiom 7). What it emits is a plan
// anything that runs containers can execute.

import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { type ComposeStrategy, composeStrategies, readComposeFile } from './cmd-deploy-compose';
import { readHelmDrainOverrides } from './cmd-deploy-drain';
import {
  type HelmTarget,
  helmUpgradeArgs,
  readHelmTimeout,
  readLabel,
  readReleaseName,
  readRollout,
} from './cmd-deploy-helm';
import { deploySpec } from './cmd-deploy-spec';
import { runStartFirst, startFirstUp } from './cmd-deploy-start-first';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';
import { quoteArg } from './shell-quote';
import { PROD_ENV_FILE } from './templates/scaffold-container-compose';

/**
 * Ordered, and the order is the design. `migrate` GATES — it runs to completion before anything
 * serves, and a schema difference after it fails the deploy. `backfill` is last and TRIGGERS: a
 * data sweep put inside a release gate holds the deploy open while a slow UPDATE runs against a
 * database still serving the PREVIOUS release, so it runs after the new pods are up and the
 * workers already draining the queue are what perform it. That is also why it is not wired into
 * `runMigrations()` and never will be.
 *
 * `backfill` is a one-shot like `migrate`, so it takes the same `run --rm` shape; the compose
 * service behind it runs `x db backfill --all --write --json` rather than a `ROLE`, because
 * `@ultimat3/core`'s `ROLES` is a closed list of process shapes and a sweep trigger is a command.
 *
 * ORDER HERE IS NECESSARY AND NOT SUFFICIENT. `docker compose up -d` returns when a container has
 * STARTED, not when the application inside it is serving, so this list alone puts the trigger after
 * the serving roles were asked to start and not after they are ready. The barrier that makes
 * "after" true is declarative and belongs to the compose file, not to this plan: the `backfill`
 * service needs `depends_on: { web: { condition: service_healthy } }`, which `docker compose run`
 * honours. Both compose definitions carry it — `docker/docker-compose.prod.yml`'s `backfill` and
 * the one `templates/scaffold-container.ts` scaffolds, which also gates on `migrate` completing.
 * This paragraph said they "still owe" both for as long as they have had them.
 *
 * COMPOSE-ONLY, and `backfill` is why that has to be written down. `docker/helm`'s `roles:` map is
 * `web|sync|worker|scheduler|replicator` plus a `migrate` Job — there is no `backfill` object in
 * the chart at all — and the helm plan is one `helm upgrade --install`, so this list describes
 * neither the objects a chart deploy creates nor the steps it runs. Every reader of it is therefore
 * inside the compose branch; the SUMMARY reads `plan.steps` instead, or `x deploy --method helm`
 * reports a post-deploy sweep to an operator that nothing will ever run.
 */
export const DEPLOY_ROLES = ['migrate', 'web', 'sync', 'worker', 'scheduler', 'backfill'] as const;

/** The two ways to run the plan. Closed, and read three ways: the default, the check, the refusal. */
export const DEPLOY_METHODS = ['compose', 'helm'] as const;

export type DeployMethod = (typeof DEPLOY_METHODS)[number];

/**
 * Refused, never defaulted. `=== 'helm' ? 'helm' : 'compose'` made every other spelling a Compose
 * deploy that reported `ok: true` and `method: "compose"` — so `x deploy --method helmm` (or
 * `Helm`, or `kubectl`) ran the six-step Compose plan against a cluster whose operator had asked
 * for a Helm upgrade, and the report agreed with the plan rather than with the request.
 * `cmd-build.ts`'s `readTarget` is the same shape for the same reason.
 */
export function readMethod(raw: string | undefined): DeployMethod {
  const methods: readonly string[] = DEPLOY_METHODS;
  if (raw === undefined) return 'compose';
  if (methods.includes(raw)) return raw as DeployMethod;
  throw new UnknownCommandError({
    path: `deploy --method ${raw}`,
    known: DEPLOY_METHODS,
    suggestion: 'deploy --method compose',
  });
}

/** The roles that run to completion and exit, as against the ones that stay up serving. */
const ONE_SHOT_ROLES: readonly string[] = ['migrate', 'backfill'];

/**
 * One step. A compose serving role carries its rollout `strategy` (`cmd-deploy-compose.ts`); a
 * start-first step's `command` is its scale-up as it runs in the steady state, where the
 * containers running equal the declared replicas — the run counts them first.
 */
export interface DeployStep {
  readonly role: string;
  readonly command: readonly string[];
  readonly strategy?: ComposeStrategy | undefined;
}

export interface DeployPlan {
  readonly image: string;
  /** Ordered: migrate runs to completion before any role that serves traffic starts. */
  readonly steps: readonly DeployStep[];
  /**
   * The environment every step runs with — how the COMPOSE method carries the image, because
   * `docker-compose.prod.yml` resolves each service from `${IMAGE:-ultimate-app:latest}` and
   * `docker compose` takes no image argument. Without it `--image` decided nothing: the plan
   * reported the reference the operator asked for while the six steps read `IMAGE` off the
   * ambient environment, or deployed `ultimate-app:latest` where it was unset. Helm carries none
   * — the chart reads `--set-string image.repository/tag`, and an env var it never looks at would be a
   * second answer to which image is being deployed.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The chart declares `image` as a MAP — `repository`, `tag`, `pullPolicy` — and `_helpers.tpl`
 * renders `repository:tag` from it, the tag defaulting to `.Chart.AppVersion`.
 * `--set image=<ref>` replaces that map with a string, so every workload template fails on
 * `.repository` and the deploy that was asked to ship one image ships nothing. The reference is
 * split into the two keys the chart actually reads; a reference with no tag sets only the
 * repository, which leaves the chart's own `default .Chart.AppVersion` in force.
 *
 * The last `:` after the last `/`, because a registry may carry a port: `localhost:5000/app` is a
 * repository with no tag and `localhost:5000/app:1.2.3` is the same repository with one.
 */
export function helmImageOverrides(image: string): readonly string[] {
  const colon = image.lastIndexOf(':');
  const tag = colon > image.lastIndexOf('/') ? image.slice(colon + 1) : '';
  const repository = tag === '' ? image : image.slice(0, colon);
  // `--set-string`, never `--set`: `--set` TYPES its value, so `image.tag=1234567` reached the chart
  // as an int64 and rendered `app:%!s(int64=1234567)` — any all-digit tag (a build number, a date,
  // a short SHA that happens to be digits) was an ImagePullBackOff behind `--wait`.
  return tag === ''
    ? ['--set-string', `image.repository=${repository}`]
    : ['--set-string', `image.repository=${repository}`, '--set-string', `image.tag=${tag}`];
}

/**
 * The OCI reference grammar (distribution/reference), tag form only — the digest form has its own
 * refusal in `planDeploy`. `[domain[:port]/]path[:tag]`: a domain of dot-separated host labels, path
 * components of lower-case alphanumerics joined by `.`, `_`, `__` or dashes, a tag of word
 * characters, `.` and `-`, at most 128. It holds none of helm's `--set-string` metacharacters (`,`
 * `=` `\` `{` `}`), so a reference it admits never needs escaping, and one it refuses is never
 * split into a second value.
 */
const LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const OCI_REFERENCE = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*(?::[0-9]+)?/)?${COMPONENT}(?:/${COMPONENT})*(?::[\\w][\\w.-]{0,127})?$`,
);

/** What was asked for: the method, and for helm the release it is aimed at. */
export type DeployRequest =
  | { readonly method: 'compose' }
  | ({ readonly method: 'helm' } & HelmDeployTarget);

/** A helm target plus the `--set` pairs that size the chart's grace periods (`cmd-deploy-drain.ts`). */
export interface HelmDeployTarget extends HelmTarget {
  readonly drain?: readonly string[] | undefined;
}

/**
 * The plan for one method. A helm plan takes its target — release, namespace, timeout — because
 * the release is read off `app.config.ts`, which only the command can import; the compose plan
 * needs none, so its three-argument form is unchanged.
 */
export function planDeploy(
  image: string,
  method: 'compose',
  root: string,
  strategies?: ReadonlyMap<string, ComposeStrategy>,
): DeployPlan;
export function planDeploy(
  image: string,
  method: 'helm',
  root: string,
  target: HelmDeployTarget,
): DeployPlan;
export function planDeploy(
  image: string,
  method: DeployMethod,
  root: string,
  extra?: HelmDeployTarget | ReadonlyMap<string, ComposeStrategy>,
): DeployPlan {
  const target = method === 'helm' ? (extra as HelmDeployTarget | undefined) : undefined;
  const strategies =
    method === 'compose' && extra instanceof Map
      ? (extra as ReadonlyMap<string, ComposeStrategy>)
      : new Map<string, ComposeStrategy>();
  if (method === 'helm') {
    // A caller from plain JS can still reach this without one; `app` for every app is the
    // defect the target exists to end, so it is refused rather than defaulted back.
    if (target === undefined) {
      throw new BadFlagError({
        flag: 'release',
        command: 'deploy',
        reason: 'a helm plan names its release, and planDeploy was called with no target',
        fix: 'x deploy --method helm --release my-app --json',
      });
    }
    // `repo@sha256:…` is a reference this chart cannot express: it renders `repository:tag` and
    // has no digest branch, so passing one through would deploy `repo@sha256:…:<appVersion>` —
    // a tag no registry has. Refused here rather than by a `helm upgrade` failing halfway.
    if (image.lastIndexOf('@') > image.lastIndexOf('/')) {
      throw new BadFlagError({
        flag: 'image',
        command: 'deploy',
        reason: `"${image}" pins a digest, and docker/helm renders repository:tag with no digest branch`,
        fix: `x deploy --method helm --image ${image.slice(0, image.lastIndexOf('@'))}:<tag> --json`,
      });
    }
    // Helm splits a `--set-string` argument on `,` and reads `=` as key/value: an image built from
    // a git ref name (`app,serviceAccount.create=true:1.2`) set a value nobody asked for. The value
    // is quoted with JSON in the cause (it may hold a newline) and never echoed into the fix.
    if (!OCI_REFERENCE.test(image)) {
      throw new BadFlagError({
        flag: 'image',
        command: 'deploy',
        reason: `${JSON.stringify(image)} is not an OCI image reference ([registry[:port]/]path[:tag], lower-case path), and helm would read its , or = as more --set-string values`,
        fix: 'x deploy --method helm --image ghcr.io/<org>/<app>:<tag> --json',
      });
    }
    return {
      image,
      env: {},
      steps: [
        {
          role: 'all',
          command: helmUpgradeArgs(root, target, [
            ...helmImageOverrides(image),
            ...(target.drain ?? []),
          ]),
        },
      ],
    };
  }
  return {
    image,
    // The one place the compose file's own variable is named. `docker/docker-compose.prod.yml`'s
    // header documents `IMAGE=… docker compose …` as the way to run it by hand; this is that line,
    // performed.
    env: { IMAGE: image },
    steps: DEPLOY_ROLES.map((role) => composeStep(composeBase(root), role, strategies.get(role))),
  };
}

/**
 * Every compose command's prefix. Compose interpolates `${SYNC_URL:?…}`, `${APP_URL:?…}` and
 * `${POSTGRES_PASSWORD:?…}` from the shell and `--env-file` only — never from a service's
 * `env_file:`. Without it an operator who put them in `.env.production`, the one file the compose
 * file tells them to fill, had every step die on a parse error. Global flag, so it precedes `-f`;
 * the shell still wins over it.
 */
const composeBase = (root: string): readonly string[] => [
  'docker',
  'compose',
  '--env-file',
  join(root, PROD_ENV_FILE),
  '-f',
  composeFileOf(root),
];

const composeFileOf = (root: string): string => join(root, 'docker', 'docker-compose.prod.yml');

/** One compose step: a one-shot `run --rm`, a start-first scale-up, or compose's own recreate. */
function composeStep(
  base: readonly string[],
  role: string,
  strategy: ComposeStrategy | undefined,
): DeployStep {
  if (ONE_SHOT_ROLES.includes(role)) return { role, command: [...base, 'run', '--rm', role] };
  if (strategy?.kind === 'start-first') {
    const scale = strategy.replicas === 0 ? undefined : strategy.replicas * 2;
    return { role, command: startFirstUp(base, role, scale), strategy };
  }
  return { role, command: [...base, 'up', '-d', role], strategy };
}

/**
 * One step, as the line an operator would type — the environment first, then the command.
 *
 * `plan.env` is the compose file's own `IMAGE=…` variable, and it is what makes `--image` true on
 * that method: a rendered line without it deploys `docker-compose.prod.yml`'s DEFAULT image. Both
 * renderers and the failure `fix:` go through here, so the plan `--json` reports, the plan the
 * terminal shows and the line the refusal hands back can never name three different deployments.
 */
/** The flags only a helm deploy reads. Named once: the spec, the refusal and the reader agree. */
const HELM_ONLY_FLAGS = ['release', 'namespace', 'timeout'] as const;

/**
 * The method and its target. A helm-only flag on the compose method is REFUSED, never dropped:
 * `--namespace staging` on a compose deploy would otherwise run against the one box there is and
 * report success, which is the silent direction every declared-and-ignored knob in this repo took.
 */
export async function readDeployRequest(
  ctx: CommandContext,
  method: DeployMethod,
  root: string,
): Promise<DeployRequest> {
  if (method === 'compose') {
    const stray = HELM_ONLY_FLAGS.find((flag) => flagString(ctx.args, flag) !== undefined);
    if (stray !== undefined) {
      throw new BadFlagError({
        flag: stray,
        command: 'deploy',
        reason: 'it applies to --method helm only; a compose deploy has one box and no release',
        fix: 'x deploy --method helm --release my-app --namespace my-namespace --json',
      });
    }
    return { method };
  }
  const namespace = flagString(ctx.args, 'namespace');
  return {
    method,
    release: await readReleaseName(root, flagString(ctx.args, 'release')),
    namespace: namespace === undefined ? undefined : readLabel('namespace', namespace),
    timeout: readHelmTimeout(flagString(ctx.args, 'timeout')),
    drain: await readHelmDrainOverrides(root),
  };
}

/**
 * What a failed start-first roll could not undo. The unhealthy replicas it created are stopped and
 * removed; when that cleanup fails too, the containers it names are still running beside the old
 * ones, and saying nothing would leave an operator rerunning a deploy over them unaware.
 */
const cleanupNote = (outcome: {
  readonly ok: false;
  readonly cleanup?: { readonly code: number; readonly command: readonly string[] } | undefined;
}): string =>
  outcome.cleanup === undefined
    ? ''
    : `; its cleanup \`${outcome.cleanup.command.map(quoteArg).join(' ')}\` exited ${outcome.cleanup.code}, so the containers it names are still running — stop and remove them before rerunning`;

const stepLine = (env: Readonly<Record<string, string>>, command: readonly string[]): string =>
  [
    ...Object.entries(env).map(([name, value]) => `${name}=${quoteArg(value)}`),
    // Every word quoted where it must be: the chart and compose paths are joined from the app
    // root, and a root holding a space or a `$(` pasted back as two words, or as a second command.
    ...command.map(quoteArg),
  ].join(' ');

export const deployCommand: CliCommand = {
  spec: deploySpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('deploy', ctx.cwd).dir;
    const image = flagString(ctx.args, 'image') ?? 'ultimate-app:dev';
    // No "is there a chart?" branch. It threw X_NOT_IMPLEMENTED — "this build does not implement
    // helm" — over a build that implements it completely (`planDeploy` above); what was missing was
    // a FILE, and its fix said to copy it from the framework repository, which `packages/cli`'s
    // `files:` ships in no tarball. `x new` writes `docker/helm` now, the way it has always written
    // `docker/docker-compose.prod.yml`. An app that deleted the chart gets helm's own error through
    // X_DEPLOY_FAILED, whose fix is the exact command to rerun.
    const method = readMethod(flagString(ctx.args, 'method'));
    const request = await readDeployRequest(ctx, method, root);
    // Read before the plan, because the plan IS the rollout: which compose roles can start their
    // new container first is a fact of the app's compose file, and a dry run reports it too.
    const plan =
      request.method === 'helm'
        ? planDeploy(image, 'helm', root, request)
        : planDeploy(
            image,
            'compose',
            root,
            composeStrategies(await readComposeFile(composeFileOf(root))),
          );
    // What the helm flags resolved to — the release above all, which is read off `app.config.ts`
    // and so is not something the operator typed. Absent on compose, which has no release.
    const target: { readonly [key: string]: JsonValue } =
      request.method === 'helm'
        ? {
            helm: {
              release: request.release,
              namespace: request.namespace ?? null,
              timeout: request.timeout,
            },
          }
        : {};
    const planJson: { readonly [key: string]: JsonValue } = {
      image: plan.image,
      method,
      ...target,
      // Reported, because it is what makes `image` above true on the compose method — a dry run
      // that names an image the steps do not carry is the defect this field closed.
      env: { ...plan.env },
      steps: plan.steps.map((step) => ({
        role: step.role,
        command: step.command.join(' '),
        ...(step.strategy === undefined ? {} : { strategy: step.strategy.kind }),
        ...(step.strategy?.kind === 'stop-first' ? { why: step.strategy.why } : {}),
      })),
    };
    // The roles THIS plan has, never the compose list: on `--method helm` there is one step,
    // `all`, and naming `backfill` there promises an operator a sweep the chart cannot run.
    const roles = plan.steps.map((step) => step.role).join(',');
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'deploy',
        summary: msg('cli.deploy.plan', { images: 1, roles }),
        data: planJson,
        lines: plan.steps.map(
          (step) => `  ${step.role.padEnd(10)} ${stepLine(plan.env, step.command)}`,
        ),
      };
    }
    // helm prints its release record (`--output json`), so the report carries helm's own verdict
    // and revision rather than an exit code standing in for one. Compose has no such record.
    let rollout: { readonly [key: string]: JsonValue } = {};
    for (const step of plan.steps) {
      const options = { cwd: root, env: plan.env };
      // A start-first step is a sequence — list, scale up, wait, stop the old — and reports the
      // command of the sub-step that failed, so the fix line below is still the one to rerun.
      const outcome =
        step.strategy?.kind === 'start-first'
          ? await runStartFirst({
              role: step.role,
              base: composeBase(root),
              replicas: step.strategy.replicas,
              runner: ctx.runner,
              options,
            })
          : await ctx.runner(step.command, options).then((result) => {
              if (request.method === 'helm')
                rollout = { rollout: { ...readRollout(request, result.stdout) } };
              return result.ok
                ? { ok: true as const }
                : { ok: false as const, code: result.code, command: step.command };
            });
      if (!outcome.ok) {
        return {
          ok: false,
          command: 'deploy',
          summary: msg('cli.deploy.plan', { images: 1, roles: step.role }),
          findings: [
            {
              code: 'X_DEPLOY_FAILED',
              cause: `role "${step.role}" step exited ${outcome.code}${cleanupNote(outcome)}`,
              fix: `${stepLine(plan.env, outcome.command)}   # run it directly to see the full output`,
              docs: ERROR_DOCS_URL,
            },
          ],
          data: { ...planJson, ...rollout },
        };
      }
    }
    return {
      ok: true,
      command: 'deploy',
      summary: msg('cli.deploy.plan', { images: 1, roles }),
      data: { ...planJson, ...rollout },
    };
  },
};
