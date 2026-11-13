#!/usr/bin/env bun
// Refuse a tracked app's `docker/Dockerfile` whose install stages differ from the scaffold
// template's: the stages up to and including the one that runs `bun install` must be the ones `x new`
// writes, instruction for instruction (comments aside).
//
// Both tracked apps copied `apps/` and `packages/` ahead of `bun install`, so an edit to one page
// re-ran the whole install, while the template (`packages/cli/src/templates/scaffold-container.ts`)
// had long copied manifests only. Nothing compared the two, so the fix reached every new app and
// not the two older ones. `--write` splices the template's stages over each drifted app's.
//
//   bun run scripts/dockerfile-template.ts [--check | --write] [--json]

// why: host-separator paths to each app's Dockerfile; Bun ships no path API.
import { basename, join } from 'node:path';
import { names } from '../packages/cli/src/templates/naming';
import { containerFiles } from '../packages/cli/src/templates/scaffold-container';
import { flagBool, parseScriptArgs } from './lib/args';
import { parseDockerfile, type Stage } from './lib/dockerfile-stages';
import { GATED_APPS } from './lib/gated-apps';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'dockerfile-template';
const CODE = 'X_DOCKERFILE_DEPS_DRIFT';
const TEMPLATE = 'packages/cli/src/templates/scaffold-container.ts';
const FIX = 'bun run scripts/dockerfile-template.ts --write';
export const APP_DOCKERFILE = 'docker/Dockerfile';

/** The template's Dockerfile, as `x new <app>` writes it. Install stages never name the app. */
export function templateDockerfile(app: string): string {
  const file = containerFiles(names(app)).find((one) => one.path === APP_DOCKERFILE);
  const contents = file !== undefined && 'contents' in file ? file.contents : '';
  return typeof contents === 'string' ? contents : '';
}

const INSTALL = /\bbun\s+install\b/;

/** Every stage up to and including the first that RUNs `bun install`; none if no stage does. */
export function installStages(text: string): readonly Stage[] {
  const stages = parseDockerfile(text);
  const at = stages.findIndex((stage) =>
    stage.instructions.some((one) => one.keyword === 'RUN' && INSTALL.test(one.value)),
  );
  return at === -1 ? [] : stages.slice(0, at + 1);
}

interface Line {
  readonly text: string;
  readonly line: number;
}

/** One comparable line per `FROM` and instruction, whitespace collapsed. */
const flatten = (stages: readonly Stage[]): readonly Line[] =>
  stages.flatMap((stage) => [
    {
      text: stage.name === undefined ? `FROM ${stage.base}` : `FROM ${stage.base} AS ${stage.name}`,
      line: stage.line,
    },
    ...stage.instructions.map((one) => ({
      text: `${one.keyword} ${one.value.replace(/\s+/g, ' ').trim()}`,
      line: one.line,
    })),
  ]);

const lineAt = (found: Line): string => `line ${found.line}, \`${found.text}\``;

/** The first difference between `text`'s install stages and the template's, as a finding. */
export function templateDrift(text: string, file: string, template: string): Finding | undefined {
  const want = flatten(installStages(template));
  const have = flatten(installStages(text));
  const at = want.findIndex((line, index) => have[index]?.text !== line.text);
  const extra = at === -1 && have.length > want.length ? want.length : at;
  if (extra === -1) return undefined;
  const found = have[extra];
  const expected = want[extra]?.text ?? '(no further instruction before the install)';
  // Helpers, not a template nested in another's `${}`: the code scanner cannot follow that nesting.
  const where = found === undefined ? 'its end' : lineAt(found);
  return {
    code: CODE,
    cause: `${file}'s install stages differ from the template's (${TEMPLATE}) at ${where}: the template has \`${expected}\`. Anything copied ahead of \`bun install\` keys its layer, so a copied source file makes every edit a full reinstall`,
    fix: FIX,
    at: found === undefined ? file : `${file}:${found.line}`,
  };
}

/** Lines `[from, to)` of the install stages: each FROM's own comment block included. */
function installSpan(text: string): readonly [number, number] | undefined {
  const stages = parseDockerfile(text);
  const install = installStages(text);
  const first = install[0];
  if (first === undefined) return undefined;
  const lines = text.split('\n');
  // Up from a FROM, over the comment block directly above it, to the blank line ending it.
  const above = (line: number): number => {
    let at = line - 1;
    while (at > 0 && /^\s*#/.test(lines[at - 1] ?? '')) at -= 1;
    return at;
  };
  const next = stages[install.length];
  let end = next === undefined ? lines.length : above(next.line);
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return [above(first.line), end];
}

/** `text` with its install stages replaced by the template's; unchanged when either has none. */
export function spliceTemplate(text: string, template: string): string {
  const mine = installSpan(text);
  const theirs = installSpan(template);
  if (mine === undefined || theirs === undefined) return text;
  const lines = text.split('\n');
  const block = template.split('\n').slice(theirs[0], theirs[1]);
  return [...lines.slice(0, mine[0]), ...block, ...lines.slice(mine[1])].join('\n');
}

/** Each tracked app that ships a `docker/Dockerfile`, its path and text. */
async function appDockerfiles(root: string) {
  const found: { readonly file: string; readonly app: string; readonly text: string }[] = [];
  for (const app of GATED_APPS) {
    const file = `${app.dir}/${APP_DOCKERFILE}`;
    const handle = Bun.file(join(root, file));
    if (await handle.exists())
      found.push({ file, app: basename(app.dir), text: await handle.text() });
  }
  return found;
}

/** What this check finds over the tracked apps in `root`. */
export async function dockerfileTemplateFindings(root: string): Promise<readonly Finding[]> {
  return (await appDockerfiles(root)).flatMap((one) => {
    const drift = templateDrift(one.text, one.file, templateDockerfile(one.app));
    return drift === undefined ? [] : [drift];
  });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    for (const one of await appDockerfiles(root)) {
      const next = spliceTemplate(one.text, templateDockerfile(one.app));
      if (next !== one.text) await Bun.write(join(root, one.file), next);
    }
  }
  const findings = await dockerfileTemplateFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every tracked app's ${APP_DOCKERFILE} installs from the template's manifests-only stages`
          : `${findings.length} tracked Dockerfile(s) drifted from the template's install stages`,
      findings,
    },
    args.json,
  );
}
