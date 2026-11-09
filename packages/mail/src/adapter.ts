// `@ultimat3/mail/adapter` — what a mail driver is built and installed from: the port interface,
// the errors a driver throws, and the boot's installer with its reset. Never the `.` barrel: an app
// swaps the driver with `mail:` in `apps/<app>/runtime.ts`, so the only callers here are the cli
// boot, `@ultimat3/testing`, and a driver's own author.

export type { MailDriver, MailMessage, SendResult } from './driver';
export { installMailDriver, resetMailDriver } from './driver';
export type { SendFailure, SendStage } from './errors';
export { MailError, sendFailed } from './errors';
