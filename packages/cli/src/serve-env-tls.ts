// `TLS_CERT` / `TLS_KEY`: the paths of the PEM pair a container's `web` role serves TLS with, read
// once at boot. Both or neither — a listener that silently stayed plaintext because one variable
// was mistyped is the failure this refuses. Absent, nothing changes: the ingress terminates TLS.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { HttpConfigInput } from '@ultimat3/http';
import type { Env } from './runtime-bindings';

export type ListenerTls = NonNullable<HttpConfigInput['tls']>;

export const TLS_CERT_KEY = 'TLS_CERT';
export const TLS_KEY_KEY = 'TLS_KEY';

/** `X_CONFIG_INVALID`, http's own code for a listener it cannot build. Never the file's bytes. */
export class ListenerTlsInvalidError extends UltimateError {
  constructor(input: { name: string; reason: string }) {
    super({
      code: 'X_CONFIG_INVALID',
      cause: `${input.name} ${input.reason}; the web role serves TLS with ${TLS_CERT_KEY} and ${TLS_KEY_KEY} together — two PEM file paths — or with neither`,
      fix: `docker run -e ${TLS_CERT_KEY}=/run/secrets/tls.crt -e ${TLS_KEY_KEY}=/run/secrets/tls.key <image>   # or unset both and terminate TLS at the ingress`,
      meta: { key: input.name },
    });
  }
}

const setValue = (env: Env, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
};

async function readPem(name: string, path: string): Promise<string> {
  const file = Bun.file(path);
  const text = (await file.exists()) ? await file.text().catch(() => '') : '';
  if (text.length === 0) {
    throw new ListenerTlsInvalidError({
      name,
      reason: `names ${renderFixShellArg(path, '<path>')}, which is missing, empty or unreadable`,
    });
  }
  return text;
}

/** The pair, read; `undefined` when neither is set. `defineHttpConfig` judges the PEM itself. */
export async function tlsFromEnv(env: Env): Promise<ListenerTls | undefined> {
  const certPath = setValue(env, TLS_CERT_KEY);
  const keyPath = setValue(env, TLS_KEY_KEY);
  if (certPath === undefined && keyPath === undefined) return undefined;
  if (certPath === undefined || keyPath === undefined) {
    const missing = certPath === undefined ? TLS_CERT_KEY : TLS_KEY_KEY;
    const present = missing === TLS_CERT_KEY ? TLS_KEY_KEY : TLS_CERT_KEY;
    throw new ListenerTlsInvalidError({
      name: missing,
      reason: `is unset while ${present} is set`,
    });
  }
  return { cert: await readPem(TLS_CERT_KEY, certPath), key: await readPem(TLS_KEY_KEY, keyPath) };
}
