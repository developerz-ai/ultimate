// A channel's catch-up read, as the page's socket runs it: an ordinary query read whose records the
// transport does NOT adopt. They come back to the channel book, which adopts them in ONE
// notification with the frames it held behind the read — the echo of a pending write among them.

import type { RecordEnvelope } from '@ultimat3/core/page';
import { pageClient } from '@ultimat3/core/page';
import { queryClientMethodFor } from '@ultimat3/query/client';

/** What a catch-up read answered for the store; `undefined` for a read that answers no records. */
export interface CatchUpRecords extends Pick<RecordEnvelope, 'records' | 'removed'> {
  /**
   * Whether the principal the read was made for is still the page's. The transport fences the read
   * itself; these rows are adopted later, by the book, so the book asks again at adoption — the
   * fence `useMutation` keeps on its own POST. Absent: always current.
   */
  readonly current?: (() => boolean) | undefined;
}

export async function catchUpRead(
  query: string,
  params: Readonly<Record<string, string>>,
): Promise<CatchUpRecords | undefined> {
  const issued = pageClient().scope.epoch;
  let answered: CatchUpRecords | undefined;
  await queryClientMethodFor(query, { baseUrl: '' })(params, {
    adopt: false,
    onEnvelope: (envelope) => {
      answered = {
        ...envelope,
        current: () => pageClient().scope.epoch === issued,
      };
    },
  });
  return answered;
}
