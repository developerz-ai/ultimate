// `x clean --services`: stop this checkout's test stack, and list every other one on the machine.
// Others are only ever listed: on a machine shared by agents, another stack may be in use right now,
// and each line carries the command that stops it.

// why: Bun ships no synchronous existence check.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { Finding, JsonValue } from './output';
import { TEST_COMPOSE_PATH } from './templates/scaffold-test-services';
import type { TestStack } from './verify-services-stack';
import {
  jsonRows,
  otherRoots,
  readStack,
  rootOfCompose,
  SERVICES_LIST,
  SERVICES_STOP,
  STACKS_LIST,
} from './verify-services-stack';

export interface ServicesCleanup {
  readonly data: JsonValue;
  readonly lines: readonly string[];
  readonly finding?: Finding;
}

interface OtherStack {
  readonly project: string;
  readonly status: string;
  readonly root: string;
  readonly gone: boolean;
}

const refused = (command: readonly string[], why: string): Finding => ({
  code: 'X_TEST_SERVICES_UNAVAILABLE',
  cause: `\`${command.join(' ')}\` could not run — ${why}`,
  fix: `${command.join(' ')}   # needs Docker running`,
  at: TEST_COMPOSE_PATH,
});

/** Test stacks of other checkouts. Best effort: failing to list them stops nothing of ours. */
async function otherStacks(root: string, own: string | undefined, runner: Runner) {
  try {
    const result = await runner(STACKS_LIST, { cwd: root });
    if (!result.ok) return [];
    return jsonRows(result.stdout).flatMap((row): OtherStack[] => {
      const [project, status, files] = [row['Name'], row['Status'], row['ConfigFiles']];
      if (typeof project !== 'string' || typeof files !== 'string' || project === own) return [];
      const other = rootOfCompose(files);
      if (other === undefined || other === root) return [];
      const state = typeof status === 'string' ? status : '';
      return [{ project, status: state, root: other, gone: !existsSync(other) }];
    });
  } catch {
    return [];
  }
}

/** `undefined` when the stack stopped; otherwise the refusal naming why. */
async function stop(root: string, runner: Runner): Promise<Finding | undefined> {
  try {
    const result = await runner(SERVICES_STOP, { cwd: root });
    return result.ok
      ? undefined
      : refused(
          SERVICES_STOP,
          `it exited ${String(result.code)}: ${execOutput(result).slice(-400)}`,
        );
  } catch (error) {
    return refused(SERVICES_STOP, renderThrowable(error));
  }
}

type Action = 'none' | 'stopped' | 'would-stop' | 'kept' | 'failed';

async function settle(
  stack: TestStack | undefined,
  input: { readonly root: string; readonly runner: Runner; readonly dryRun: boolean },
): Promise<{ readonly action: Action; readonly owner?: string; readonly finding?: Finding }> {
  if (stack === undefined) return { action: 'none' };
  const [owner] = otherRoots(stack, input.root);
  if (owner !== undefined) return { action: 'kept', owner };
  if (input.dryRun) return { action: 'would-stop' };
  const finding = await stop(input.root, input.runner);
  return finding === undefined ? { action: 'stopped' } : { action: 'failed', finding };
}

export async function cleanServices(input: {
  readonly root: string;
  readonly runner: Runner;
  readonly dryRun: boolean;
}): Promise<ServicesCleanup> {
  const { root, runner } = input;
  let stack: TestStack | undefined;
  if (existsSync(join(root, TEST_COMPOSE_PATH))) {
    const read = await readStack(root, runner);
    if (!read.answered) {
      return {
        data: { action: 'failed' },
        lines: [],
        finding: refused(SERVICES_LIST, 'Docker gave no answer about this app’s stack'),
      };
    }
    stack = read.stack;
  }
  const outcome = await settle(stack, input);
  const others = await otherStacks(root, stack?.project, runner);
  const project = stack?.project ?? '';
  const services = stack?.services.join(', ') ?? '';
  return {
    data: {
      action: outcome.action,
      ...(stack === undefined ? {} : { project, services: [...stack.services] }),
      ...(outcome.owner === undefined ? {} : { owner: outcome.owner }),
      others: others.map((other) => ({ ...other })),
    },
    lines: [
      ...(outcome.action === 'failed'
        ? []
        : [
            msg(`cli.clean.services.${outcome.action}`, {
              project,
              services,
              owner: outcome.owner ?? '',
            }),
          ]),
      ...others.map((other) =>
        msg(other.gone ? 'cli.clean.services.otherGone' : 'cli.clean.services.other', {
          project: other.project,
          status: other.status,
          root: other.root,
        }),
      ),
    ],
    ...(outcome.finding === undefined ? {} : { finding: outcome.finding }),
  };
}
