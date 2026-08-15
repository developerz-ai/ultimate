/**
 * What the contact island posts, decided once and without a DOM. The island beside this file is
 * event wiring; the rule is here, so it runs in a test with no `document` — the same split
 * `@ultimat3/ui` draws between a component and its `*-view.ts`.
 */

/** Exactly `contactSales`'s input, as strings: the wire is form fields either way. */
export interface Enquiry {
  readonly email: string;
  readonly plan: string;
  readonly currency: string;
  readonly message: string;
  readonly locale: string;
}

const REQUIRED = ['email', 'plan', 'currency', 'message', 'locale'] as const;

/**
 * `null` when the form did not carry every field the action requires — a field renamed on the
 * server, or a shell this island never rendered. The island answers that by leaving the browser's
 * own submit alone: the server-rendered `<form method="post">` posts to the same action, so the
 * enquiry still arrives. Enhancement that cannot find its target must not break what it enhances.
 *
 * Values are trimmed and blanks are dropped rather than sent: `message` is `min(1)` on the action,
 * and a body of three spaces should read as "the visitor typed nothing", not as X_INPUT_INVALID.
 */
export function enquiryFrom(entries: Iterable<readonly unknown[]>): Enquiry | null {
  const values = new Map<string, string>();
  for (const [key, value] of entries) {
    // Widened rather than tupled: `FormData`'s own iterator is typed `string[]` in this lib set,
    // so a `[string, unknown]` parameter refuses the one caller this exists for.
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') values.set(key, trimmed);
  }
  for (const key of REQUIRED) {
    if (!values.has(key)) return null;
  }
  return {
    email: values.get('email') ?? '',
    plan: values.get('plan') ?? '',
    currency: values.get('currency') ?? '',
    message: values.get('message') ?? '',
    locale: values.get('locale') ?? '',
  };
}
