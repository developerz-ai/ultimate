// The failure modes of a SESSION a service is built on: an exit the driver cannot dial, and a
// prompt answered over the event bus. Split from `error-throws.ts`, which stands at its size
// ceiling; the codes themselves stay declared in `errors.ts` — one registry, one place.

import { ScrapeError } from './errors';
import { endpointLabel } from './url-secrets';

/**
 * A driver handed an exit it cannot dial. Scheme and host of both exits and nothing else: an exit
 * URL carries the proxy account in its userinfo, and this cause is written to the dead-letter row.
 */
export const egressUnsupported = (input: {
  readonly driver: string;
  readonly egress: string;
  readonly reason: string;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_EGRESS_UNSUPPORTED',
    cause: `the ${input.driver} driver cannot give this session the exit ${endpointLabel(input.egress)}: ${input.reason}`,
    fix: 'pass remoteBrowser({ cdpUrl: resolver }) so each run rents a browser on its own exit, or drop egress: from the scrape() definition and set the exit once on the driver — remoteBrowser({ proxy })',
    meta: { driver: input.driver, egress: endpointLabel(input.egress) },
  });

/**
 * The exit `egress` answered carries a credential, and that credential is in the job's own input —
 * so it rode the queue payload and sits in `x_jobs` in the clear (`redactInput` hides a key by
 * NAME for display; the column is untouched). Scheme and host only, like every exit this package
 * prints: the cause is written to the dead-letter row, beside the payload it is about.
 */
export const egressInPayload = (input: {
  readonly scrape: string;
  readonly egress: string;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_EGRESS_IN_PAYLOAD',
    cause: `scrape "${input.scrape}" was given the exit ${endpointLabel(input.egress)} with a credential that is also in the run's input, so the credential is stored in the queue row in the clear`,
    fix: `enqueue the id of the row that holds the exit, and resolve it in the worker: egress: async ({ connectionId }) => (await repo.connectionById(connectionId))?.exit on scrape("${input.scrape}") — a .sealed() column keeps it encrypted at rest — then rotate the exposed credential`,
    meta: { scrape: input.scrape, egress: endpointLabel(input.egress) },
  });

/**
 * `eventPrompt()` waited its whole budget. The event name is in the cause because it is the one
 * fact the answering side needs and cannot guess: the run id and the prompt's index within it.
 */
export const promptTimedOut = (input: {
  readonly scrape: string;
  readonly label: string;
  readonly event: string;
  readonly waitedMs: number;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PROMPT_UNANSWERED',
    cause: `scrape "${input.scrape}" asked for "${input.label}" and no answer was published to ${input.event} within ${String(input.waitedMs)}ms`,
    fix: 'call answerPrompt({ runId, index, answer }) with the run id and index the event name in the cause ends with, from a process on the same STORED event bus — setEventBus(createPgEventBus({ executor })) — or raise eventPrompt({ timeout })',
    meta: {
      scrape: input.scrape,
      label: input.label,
      event: input.event,
      waitedMs: input.waitedMs,
    },
  });

/** Something was published to the prompt's event that `answerPrompt()` did not write. */
export const promptAnswerInvalid = (input: {
  readonly scrape: string;
  readonly label: string;
  readonly event: string;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PROMPT_UNANSWERED',
    cause: `scrape "${input.scrape}" asked for "${input.label}" and the event published to ${input.event} does not carry a sealed answer`,
    fix: 'publish the answer with answerPrompt({ runId, index, answer }) and never publishEvent() by hand — the answer is sealed for this one prompt, so a plain payload is refused rather than typed into the site',
    meta: { scrape: input.scrape, label: input.label, event: input.event },
  });
