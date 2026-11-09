// `@ultimat3/scraping/adapter` — the `scrapeDriver` port: the interface a browser driver
// implements, the errors it throws, and the boot's installer. The installer lives here and never on
// the `.` barrel, so `scrapeDriver` in `apps/<app>/runtime.ts` is the one way an app picks a browser.

export type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
export { installScrapeDriver, resetScrapeDriver } from './driver';
export {
  browserUnreachable,
  cdpAttachFailed,
  hostBlocked,
  notActionable,
  pageCrashed,
  profileLocked,
  remoteRequired,
  scrapeTimeout,
  selectorMissing,
} from './error-throws';
export { egressUnsupported } from './error-throws-session';
export { isScrapeError, ScrapeError } from './errors';
export type { ScrapeHttp } from './http';
export type { ScrapePage } from './page';
