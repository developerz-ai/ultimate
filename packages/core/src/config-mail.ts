// Single responsibility: the `mail` block of `app.config.ts` — what the boot hands
// `@ultimat3/mail`'s `selectMailDriver` that an environment cannot say. Its own file for the
// reason `config-islands.ts` is: shape, merge and screen are one subject, and `config.ts` is at its
// 500-line ceiling.

import { describeValue } from './error-render';
import { isJsonObject } from './json-object';

/**
 * Keep the exact MIME bytes the SMTP and SES transports hand their provider, bounded — the audit
 * half of a send (`SendResult.mime`). `false` keeps nothing, the default. `maxBytes` unset is
 * mail's own default cap; its ceiling is mail's to enforce, at driver selection
 * (`X_CONFIG_INVALID`), because tier 0 cannot import the package that owns the number. Resend
 * builds the MIME on its own side, so asking for it with `RESEND_API_KEY` set refuses the boot.
 *
 * Data only: the durable `onRetained` callback is a function and lives with the code that writes
 * the audit row, not in a config value.
 */
export interface MailRetainMimeConfig {
  readonly maxBytes: number | undefined;
}

export interface MailConfig {
  readonly retainMime: MailRetainMimeConfig | false;
}

export interface MailSection {
  readonly mail: MailConfig;
}

export interface MailSectionInput {
  readonly mail?:
    | {
        /** `true` is `{}` — retained under mail's default cap. */
        readonly retainMime?: boolean | { readonly maxBytes?: number | undefined } | undefined;
      }
    | undefined;
}

/** The last layer that said it wins, as every scalar does. `true` is the default cap. */
export function mergeMail(layers: readonly MailSectionInput[]): MailSection {
  let retainMime: MailConfig['retainMime'] = false;
  for (const layer of layers) {
    const said = layer.mail?.retainMime;
    if (said === undefined) continue;
    if (said === true) retainMime = { maxBytes: undefined };
    else if (isJsonObject(said)) retainMime = { maxBytes: said['maxBytes'] as number | undefined };
    // `false`, or a wrong value from an untyped file — `'yes'`, `[]` — carried through AS WRITTEN
    // for `mailIssues` to refuse: read as an object it became `{ maxBytes: undefined }`, retention
    // switched on. `isJsonObject`, never `typeof`: a list is an object to `typeof`.
    else retainMime = said as MailConfig['retainMime'];
  }
  return { mail: { retainMime } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function mailIssues(config: MailSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const retain: unknown = config.mail.retainMime;
  if (retain === false) return;
  if (!isJsonObject(retain)) {
    issues.push(
      `mail.retainMime must be true, false or { maxBytes }, not ${describeValue(retain)}`,
    );
    return;
  }
  const maxBytes: unknown = retain['maxBytes'];
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1)) {
    issues.push(
      `mail.retainMime.maxBytes must be a whole number of bytes above 0, not ${describeValue(maxBytes)}`,
    );
  }
}
