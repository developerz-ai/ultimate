/**
 * "A new version is live." Version skew is a signal, not a 404: the reader reloads when they
 * choose to, and nothing is thrown away mid-edit.
 *
 * It guards on `hasLiveClient()` because the shell renders on the server too, where there is no
 * socket and therefore nothing to announce — calling `useConnection()` there is `X_LIVE_CLIENT_MISSING`,
 * which is the right error in the wrong place.
 */

import { hasLiveClient, useConnection } from '@ultimat3/realtime';
import { Alert } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';

export type UpdateBannerProps = {
  /** Already translated: this component renders copy, it does not look it up. */
  readonly label: string;
  readonly action: string;
};

export const UpdateBanner = (props: UpdateBannerProps): JSX.Element => {
  if (!hasLiveClient()) return null;
  const connection = useConnection();

  return (
    <Show when={connection.updateAvailable !== null}>
      <Alert tone="info">
        {props.label}{' '}
        <button type="button" onClick={() => location.reload()}>
          {props.action}
        </button>
      </Alert>
    </Show>
  );
};
