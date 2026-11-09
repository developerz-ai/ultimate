// `step.waitForEvent`: the stored answer, a hit parsed by the wait's own schema, the timeout called
// on the bus's clock, and the park. Split from `steps.ts` at the file-size ceiling — that file is
// the runner; this is one of its three step kinds, over the `RunnerCore` it shares.

import { logger, renderThrowable } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import { finiteDurationMs } from './clock';
import { JobTimeoutError } from './errors';
import { JobEventInvalidError } from './errors-steps';
import type { WaitForEventOptions } from './steps-api';
import type { RunnerCore } from './steps-core';
import { jsonForm } from './steps-output';
import type { StepRecord } from './steps-store';
import {
  isWaitTimedOut,
  StepSuspension,
  WAIT_TIMED_OUT,
  waitFloor,
  waitFloorOf,
} from './steps-suspension';

const DEFAULT_WAIT_MS = 86_400_000;

type Hit = { readonly id: string; readonly payload: unknown; readonly publishedAt: number };

export function waitForEventStep(core: RunnerCore) {
  const { runId, jobName } = core;
  return async function waitForEvent<S extends StandardSchemaV1>(
    name: string,
    event: string,
    waitOptions: WaitForEventOptions<S>,
  ): Promise<InferOutput<S> | undefined> {
    /** The store keeps the raw payload; a hit and a replay parse it alike, so both see one value. */
    const answer = async (payload: unknown): Promise<InferOutput<S>> => {
      const parsed = await validateAsync(waitOptions.schema, payload);
      if (parsed.issues === undefined) return parsed.value;
      const issues = formatIssues(parsed.issues);
      throw new JobEventInvalidError({ job: jobName, step: name, event, issues });
    };

    core.claim(name);
    const existing = await core.load(name);
    if (existing?.status === 'completed') {
      core.replayed(name);
      return isWaitTimedOut(existing.output) ? undefined : answer(existing.output);
    }
    await core.forwardOnly(name);

    const at = core.now();
    // A NEW wait is stamped by the bus, whose clock stamps every `publishedAt` it is compared
    // with; the runner's own only when there is no bus to ask. A re-poll keeps what it persisted.
    const startedAt = existing?.startedAt ?? (await core.events?.now()) ?? at;
    const timeoutMs = finiteDurationMs(
      waitOptions.timeout ?? DEFAULT_WAIT_MS,
      'step.waitForEvent',
      'timeout',
    );
    const deadline = startedAt + timeoutMs;
    const correlationKey = waitOptions.match;
    const attempts = (existing?.attempts ?? 0) + 1;
    const keyed = correlationKey === undefined ? {} : { correlationKey };

    const floor = waitFloorOf(existing?.output);
    const parked = {
      runId,
      name,
      status: 'waiting',
      startedAt,
      event,
      attempts,
      ...keyed,
    } as const;

    /** A found event, parsed before it is recorded: a refused one is no step's answer. */
    const consume = async (hit: Hit): Promise<InferOutput<S>> => {
      // The form a replay will parse, so a hit cannot answer what its replay refuses.
      const stored = jsonForm(hit.payload, { job: jobName, step: name });
      const value = await answer(stored).catch(async (refusal: unknown) => {
        // The original error is what the caller sees; without the floor a retry is refused again.
        await core
          .put({
            ...parked,
            output: waitFloor({ afterMs: hit.publishedAt, afterId: hit.id }),
            wakeAt: at,
          })
          .catch((unwritten: unknown) =>
            logger.warn('jobs.step.floor-unrecorded', {
              job: jobName,
              step: name,
              error: renderThrowable(unwritten),
            }),
          );
        throw refusal;
      });
      const done: StepRecord = {
        ...parked,
        status: 'completed',
        output: stored,
        completedAt: at,
      };
      await core.put(done);
      return value;
    };

    const hit = await core.events?.find(
      event,
      correlationKey,
      floor?.afterMs ?? startedAt,
      floor?.afterId,
    );
    if (hit !== undefined) return consume(hit);

    // `deadline` is on the BUS's clock, so the bus calls the timeout: asked only once this runner
    // believes the time is up, which costs a wait one statement at its end. A runner AHEAD of the
    // bus used to give up early by the skew — on an answer still inside its window. (A runner
    // BEHIND waits the skew longer; knowing that sooner would cost a round trip on every poll.)
    let remaining = deadline - at;
    if (remaining <= 0) remaining = deadline - ((await core.events?.now()) ?? at);
    if (remaining <= 0) {
      if (waitOptions.required === true) {
        throw new JobTimeoutError({
          job: jobName,
          step: name,
          timeoutMs,
          fix: `step.waitForEvent('${name}', '${event}', { timeout: '1h' })   # raises the wait's timeout; or make the publisher of "${event}" send it sooner`,
        });
      }
      logger.warn('jobs.step.wait-timeout', { job: jobName, step: name, event });
      await core.put({
        runId,
        name,
        status: 'completed',
        output: WAIT_TIMED_OUT,
        startedAt,
        completedAt: at,
        event,
        attempts,
      });
      return undefined;
    }

    const resumeAt = at + Math.min(remaining, core.pollMs);
    await core.put({
      ...parked,
      wakeAt: resumeAt,
      ...(floor === undefined ? {} : { output: waitFloor(floor) }),
    });
    // A waking bus wakes only the runs it finds `waiting`, so an event committed between the first
    // `find` and the write above woke nobody. Asked once more: one that commits after THIS read
    // meets a `running` row, which the wake leaves alone, and is the backstop poll's.
    if (core.events?.wakes === true) {
      const late = await core.events.find(
        event,
        correlationKey,
        floor?.afterMs ?? startedAt,
        floor?.afterId,
      );
      if (late !== undefined) return consume(late);
    }
    throw new StepSuspension({ step: name, resumeAt, reason: 'event' });
  };
}
