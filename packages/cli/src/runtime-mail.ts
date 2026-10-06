// The `mail` section of `app.config.ts` the boot obeys: `mail.retainMime`, handed to
// `@ultimat3/mail`'s `selectMailDriver` — the one option an environment cannot carry. Selection
// still reads env for WHICH transport; the config only says what the chosen one keeps.

import type { AppConfig } from '@ultimat3/core';
import type { MailEnvironment, MailSelection, MailSelectOptions } from '@ultimat3/mail';
import { selectMailDriver } from '@ultimat3/mail';

/** No config file, or `retainMime: false`, is no option at all — never `retainMime: undefined`. */
export function mailSelectOptionsOf(config: AppConfig | undefined): MailSelectOptions {
  const retain = config?.mail.retainMime ?? false;
  if (retain === false) return {};
  return { retainMime: retain.maxBytes === undefined ? {} : { maxBytes: retain.maxBytes } };
}

/**
 * The boot's mail selection. Pure, as `selectMailDriver` is: it builds a transport and dials
 * nothing, so a cap above mail's ceiling or retention asked of Resend refuses the boot here.
 */
export const selectAppMailDriver = (
  env: MailEnvironment,
  config: AppConfig | undefined,
): MailSelection => selectMailDriver(env, mailSelectOptionsOf(config));
