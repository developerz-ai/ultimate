// Which service a served role's signals name, and which build (#1361). The OTel env first —
// `OTEL_SERVICE_NAME`, then `service.name` in `OTEL_RESOURCE_ATTRIBUTES` — set before the app's
// config loads so the spans its load opens carry it; then the app's `name` only where the env was
// silent. Version: `service.version` in the attributes, else the build id, else `APP_VERSION`.

import { appVersion, configureTelemetry, logger } from '@ultimat3/core';

type Env = Readonly<Record<string, string | undefined>>;

const ATTRIBUTES_KEY = 'OTEL_RESOURCE_ATTRIBUTES';

/** Empty is unset: a platform that exports a key bare has named nothing. */
const said = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/** One `key=value` pair, or `undefined` when it is malformed (no key, no `=`, a bad escape). */
function pairOf(entry: string): readonly [string, string] | undefined {
  const at = entry.indexOf('=');
  const key = at === -1 ? '' : entry.slice(0, at).trim();
  if (key === '') return undefined;
  try {
    return [key, decodeURIComponent(entry.slice(at + 1).trim())];
  } catch {
    return undefined;
  }
}

/**
 * `OTEL_RESOURCE_ATTRIBUTES` as the OTel SDK spec reads it: comma-separated `key=value`, values
 * percent-decoded. One malformed pair discards the WHOLE value with one warning — the spec's rule,
 * and the safe one: a half-read list could name the service from the wrong pair.
 */
export function resourceAttributes(env: Env): ReadonlyMap<string, string> {
  const raw = said(env[ATTRIBUTES_KEY]);
  const out = new Map<string, string>();
  if (raw === undefined) return out;
  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue;
    const pair = pairOf(entry);
    if (pair === undefined) {
      // The value is never echoed: a deploy may carry anything in a resource attribute.
      logger.warn('ultimate otel resource attributes ignored', {
        cause: `${ATTRIBUTES_KEY} holds a pair that is not key=value with a percent-encoded value, so the whole variable is ignored`,
        fix: `${ATTRIBUTES_KEY}=service.name=<name>,service.version=<version>   # comma-separated, values percent-encoded`,
      });
      return new Map();
    }
    out.set(pair[0], pair[1]);
  }
  return out;
}

export interface ServiceIdentity {
  /** Absent when the env names no service: the app's `name` fills it after the config loads. */
  readonly serviceName?: string;
  readonly serviceVersion: string;
}

/**
 * What the env alone can say, before the config or the build id is resolved. A stamped
 * `BUILD_ID` is read here already, so a span opened while the app loads carries the build.
 */
export function serviceIdentityFromEnv(env: Env): ServiceIdentity {
  return identityOf(env, resourceAttributes(env));
}

/** Parsed once per boot by its caller: a malformed value warns once, not once per reader. */
function identityOf(env: Env, attributes: ReadonlyMap<string, string>): ServiceIdentity {
  const name = said(env['OTEL_SERVICE_NAME']) ?? said(attributes.get('service.name'));
  const serviceVersion =
    said(attributes.get('service.version')) ?? said(env['BUILD_ID']) ?? appVersion(env);
  return name === undefined ? { serviceVersion } : { serviceName: name, serviceVersion };
}

export interface ServiceIdentityBoot {
  readonly named: (appName: string | undefined) => void;
  readonly built: (buildId: string) => void;
  readonly release: () => void;
}

/**
 * Names the service from the env, before anything else in the boot runs, and answers the two
 * later steps and the release. `named(app)` is the config's turn; `built(id)` the resolved build
 * id's — both lose to what the env said.
 */
export function configureServiceIdentity(env: Env): ServiceIdentityBoot {
  const attributes = resourceAttributes(env);
  const early = identityOf(env, attributes);
  const releases = [configureTelemetry(early)];
  const versionSaid = said(attributes.get('service.version')) !== undefined;
  return {
    named(appName) {
      if (early.serviceName !== undefined || appName === undefined) return;
      releases.push(configureTelemetry({ serviceName: appName }));
    },
    built(buildId) {
      if (versionSaid || buildId === '') return;
      releases.push(configureTelemetry({ serviceVersion: buildId }));
    },
    release() {
      // Newest first: each release restores what its own call found.
      for (const release of releases.splice(0).reverse()) release();
    },
  };
}
