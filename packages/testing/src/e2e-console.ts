// One console line an e2e page printed, as the port answers it: a `console.*` call or an uncaught
// exception. Its own file so the port (`e2e-page.ts`) and the CDP tab can share it.

/** `console.*`'s level as Chrome reports it (`console.warn` is `warning`). */
export type E2eConsoleLevel = 'debug' | 'log' | 'info' | 'warning' | 'error';

export interface E2eConsoleMessage {
  readonly level: E2eConsoleLevel;
  /** The call's arguments as the console shows them, joined by one space. */
  readonly text: string;
  /** `console` for a `console.*` call; `exception` for a throw nothing caught (always `error`). */
  readonly source: 'console' | 'exception';
}
