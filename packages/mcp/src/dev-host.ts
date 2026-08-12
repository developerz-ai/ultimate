// Wires the framework's own description functions into a `DevHost` and assembles the dev
// MCP server. Split from `dev-server.ts` so the tool definitions stay dependency-free and
// unit-testable against a fake host — this file is the only place that reaches into the
// primitive registries.

import { describeActions } from '@ultimat3/action';
import { frameworkVersion } from '@ultimat3/core';
import { describeEntities } from '@ultimat3/entity';
import { describeJobs, inspectJob, jobDriver } from '@ultimat3/jobs';
import { describeQueries } from '@ultimat3/query';
import type { DevCapabilities, DevHost, DevIntrospection } from './dev-server';
import { devTools } from './dev-server';
import type { FrameworkResourceProviders } from './resources';
import { frameworkResources } from './resources';
import { createMcpServer, type McpServer } from './server';

/**
 * The description half of a real app's `DevHost`. `routes` and `policies` are supplied by
 * the caller: the route table lives in `@ultimat3/render` and the policy catalog is
 * assembled per app, both outside what this tier may import.
 */
export function frameworkIntrospection(
  extra: Pick<DevIntrospection, 'routes' | 'policies'>,
): DevIntrospection {
  return {
    routes: extra.routes,
    policies: extra.policies,
    entities: () => describeEntities(),
    actions: () => describeActions(),
    queries: () => describeQueries(),
    jobs: () => describeJobs(),
    // inspectJob needs a driver; the ambient one is set at boot by the app's job config.
    // Reported as a tool error rather than thrown, so `x mcp` stays usable without a queue.
    jobInspect: (name: string) => {
      const driver = jobDriver();
      if (driver === undefined) return { error: 'no job driver configured' };
      return inspectJob(driver, name);
    },
  };
}

export interface CreateDevServerInput {
  readonly host: DevHost;
  readonly resources?: FrameworkResourceProviders;
}

/** `x mcp serve` and `POST /mcp` in dev both build the server through this. */
export function createDevServer(input: CreateDevServerInput): McpServer {
  return createMcpServer({
    tools: devTools(input.host),
    resources: frameworkResources(input.resources ?? {}),
    serverInfo: { name: 'ultimate-dev', version: frameworkVersion() },
  });
}

/** Compose the two halves without spelling out the intersection at every call site. */
export function devHost(introspection: DevIntrospection, capabilities: DevCapabilities): DevHost {
  return { ...introspection, ...capabilities };
}
