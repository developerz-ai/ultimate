// The `/_x` dev dashboard's own door, reached as `@ultimat3/admin/dev`.
//
// Separate from the package root on purpose. `src/dev/*` is a development tool and `src/*` is
// production app-admin code built on Solid components — one entry point for both would mean the
// CLI, whose only job here is to MOUNT `/_x`, pulls a component tree into every `x dev` process.
// Two products, two doors: this is the boundary `dev/data.ts`'s dynamic imports already assume.

export { type DevSourceOptions, defaultDevSources, staticDevSources } from './data';
export type {
  CacheEdgeFact,
  ColumnFact,
  DevSources,
  DriftFact,
  InvalidationFact,
  JobDefFact,
  JobRunFact,
  JobStepFact,
  LiveQueryFact,
  LiveSubscriberFact,
  MailFact,
  ManifestFact,
  PolicyFact,
  QueueFact,
  RequestTrace,
  RouteFact,
  SpanKind,
  SqlResult,
  TableFact,
  TaskFact,
  TimelineSpan,
} from './facts';
export { type DevPanel, type PanelPayload, panelPayload } from './panel';
export { type CachePanelData, cachePanel } from './panel-cache';
export { assertReadOnly, type DbPanelData, dbPanel } from './panel-db';
export { type JobsPanelData, jobsPanel } from './panel-jobs';
export { type LivePanelData, livePanel } from './panel-live';
export { type MailPanelData, mailPanel } from './panel-mail';
export { type ManifestPanelData, manifestPanel } from './panel-manifest';
export { type PolicyPanelData, policyPanel } from './panel-policy';
export { type RoutesPanelData, routesPanel } from './panel-routes';
export { type TimelinePanelData, timelinePanel } from './panel-timeline';
export {
  assertDevOnly,
  DEV_BASE_PATH,
  DEV_PANELS,
  type DevDashboard,
  type DevDashboardOptions,
  devDashboard,
} from './server';
