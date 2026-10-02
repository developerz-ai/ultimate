/**
 * The app's request deadline — how long an idempotency record bound to a transaction may stay in
 * flight before a retry takes the key. Read from `@ultimat3/http`'s own declaration and resolved
 * by its own `defineHttpConfig`, so the default and its screen are never restated here.
 */
import { configuredHttp, defineHttpConfig } from '@ultimat3/http';

let resolved: { readonly declared: number | undefined; readonly ms: number } | undefined;

/**
 * `configureHttp({ requestTimeoutMs })`, else http's default; `0` is "no deadline". Read on every
 * call because the app declares it at module scope AFTER the boot has built its stores — resolved
 * once per declared value, since `defineHttpConfig` screens a whole config to answer one field.
 */
export function requestDeadlineMs(): number {
  const declared = configuredHttp()?.requestTimeoutMs;
  if (resolved === undefined || resolved.declared !== declared) {
    const config = defineHttpConfig({
      ...(declared === undefined ? {} : { requestTimeoutMs: declared }),
      rateLimit: { enabled: false, scope: 'process' },
    });
    resolved = { declared, ms: config.requestTimeoutMs };
  }
  return resolved.ms;
}
