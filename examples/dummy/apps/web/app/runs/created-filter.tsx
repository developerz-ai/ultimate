/**
 * The runs page's "created between" form: a GET to `/runs` with `DateRangePicker`'s two native
 * date inputs. One component, rendered by the page on the server and again by the run console's
 * island in the browser (which adds the calendar), so both post exactly the same thing.
 */

import { Button, DateRangePicker } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

/** The two GET parameters the form posts, which `connection-filter.ts` reads back. */
export const CREATED_FROM = 'from';
export const CREATED_TO = 'to';

// A type alias: an island prop must be JSON. The locale, the zone the calendar opens on today in
// and the `ui.*` strings are the island's own props, read through its one `UiProvider`.
export type CreatedFilterProps = {
  readonly from: string | null;
  readonly to: string | null;
  readonly labels: { readonly legend: string; readonly submit: string };
};

/** The one form, server and browser alike. */
export function CreatedFilter(props: CreatedFilterProps): JSX.Element {
  return (
    <form method="get" action="/runs" data-role="created-filter">
      <DateRangePicker
        legend={props.labels.legend}
        fromName={CREATED_FROM}
        toName={CREATED_TO}
        from={props.from ?? undefined}
        to={props.to ?? undefined}
      />
      <Button type="submit" variant="secondary">
        {props.labels.submit}
      </Button>
    </form>
  );
}
