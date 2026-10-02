/**
 * What one run did, one row per phase. Written by the job and never updated: the console reads
 * them live, in `seq` order. `runId` references the run's own row (`runs`), so the operator's view
 * of a run lists these as its related rows.
 *
 * `seq` starts at 1 and the database says so (`run_event_seq_from_one`). A sequence that starts at
 * 0 beside a reader that asks for `seq > 0` loses its first event, and each side's tests agree
 * with themselves. `(runId, seq)` is unique, so two writers of one run cannot both take a number.
 *
 * A plain entity. `appendOnly` does not exist in this tree — when it lands, this is the table to
 * declare it on, and the `update`/`delete` it then refuses are the ones nothing here calls.
 */

import {
  entity,
  enumerated,
  type Infer,
  integer,
  invariant,
  json,
  t,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { orgs } from './orgs';
import { runs } from './runs';

/**
 * One per phase a run reports. `failed` and `done` end a run; `prompt` waits for a person.
 * `usage` is not a phase: it is what the run used, written once it ended, and moves no state.
 */
export const RUN_EVENT_KINDS = [
  'prompt',
  'answered',
  'navigated',
  'extracted',
  'done',
  'failed',
  'usage',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

const count = t.number.int().min(0);

/**
 * `ScrapeUsage`'s counts, as the run recorded them. `browserCost` is not here: the recorded site
 * rents no browser, so the column would hold a value no run of this app produces.
 */
export const RunUsage = t.object({
  browserMs: count,
  navigations: count,
  httpRequests: count,
  bytesIn: count,
  promptsAnswered: count,
});
export type RunUsage = Infer<typeof RunUsage>;

export const RUN_EVENT_MESSAGE_MAX = 200;

export const runEvents = entity('run_events', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    /** The JOB's run id: the one identity the prompt handler, the body and the answer all hold. */
    runId: uuid().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer(),
    kind: enumerated(RUN_EVENT_KINDS),
    at: timestamp().defaultNow(),
    /** A detail, never prose: the site's own prompt label, a row count, an `X_*` code. */
    message: text({ max: RUN_EVENT_MESSAGE_MAX }),
    /** Which prompt of the run is waiting — `PromptRequest.index`. Set on `prompt` rows only. */
    prompt: integer().nullable(),
    /** Set on `usage` rows only. */
    usage: json(RunUsage).nullable(),
  },
  invariants: (c) => [
    invariant('run_event_seq_from_one', c.seq.atLeast(1)),
    invariant('run_event_seq_unique', c.unique(['runId', 'seq'])),
  ],
  indexes: [{ on: ['orgId', 'runId', 'seq'] }],
});

export type RunEvent = typeof runEvents.$row;
