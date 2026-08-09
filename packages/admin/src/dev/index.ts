// The `/_x` dev dashboard's own door, reached as `@ultimat3/admin/dev`.
//
// A separate door from the package root on purpose: the CLI's only job here is to MOUNT `/_x`,
// so it must never pull `src/*`'s production Solid component tree into every `x dev` process.

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
