// `@ultimat3/core/adapter`: what an adapter author implements for core's ports (`ADAPTER_PORTS`
// rows owned by `@ultimat3/core`), the built-ins to copy or compose, and the INSTALLERS. Installers
// live here and never on the barrel: the boot (`apps/<app>/runtime.ts`) and `@ultimat3/testing`
// are their only callers, so an app module cannot swap a backend behind the boot's back.

export type { AdapterSlot } from './adapter-slot';
export { adapterSlot } from './adapter-slot';
export type { AuditRecord, AuditSink } from './audit';
export { installAuditSink, resetAuditSink } from './audit';
/** The boot's context for `bootWarning`: its roles and per-build store. cli's `startRoles` alone. */
export { installBootWarnings } from './boot-warning';
/** The build id the boot resolved (`BUILD_ID` stamped, else the manifest hash); `'dev'` unbooted. */
export { installBuildId, installedBuildId } from './build-id';
export type { Clock, FrozenClock, SleepClock } from './clock';

export type { ErrorReport, ErrorReporter } from './error-reporter';
export { installErrorReporter } from './error-reporter';
export type { FailureBundle, FailureCaptureLimits, FailureStore } from './failure-capture';
export { installFailureStore } from './failure-capture';
export type { MasterKeyRef, SecretSource, SecretSourceContext } from './secret-source';
export {
  defaultSecretSource,
  envSecretSource,
  fileSecretSource,
  installSecretSource,
} from './secret-source';
export { SecretsKeyMissingError } from './secrets-errors';
export { installClock, noWaitClock, systemClock } from './sleep-clock';
/** The service identity, sampler and clock, with the release the boot's stop calls. */
export { installTelemetry } from './telemetry';
