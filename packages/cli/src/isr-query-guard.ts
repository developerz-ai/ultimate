// The `query` object a page component is handed. For an `isr` route that declared
// `revalidate.query` it holds the declared parameters only — and, outside production, it says so
// once when the page reads any other one: that read is a document varying on something its stored
// key does not carry, which is one visitor's page answered to every visitor after.

import type { ResolveEnvironmentOptions } from '@ultimat3/core';
import { logger, tryResolveEnvironment } from '@ultimat3/core';
import type { RouteEntry } from '@ultimat3/render';

type Query = Readonly<Record<string, string>>;

/** `<route file>\u0000<parameter>` already told — bounded by what the app's source can read. */
const told = new Set<string>();

/** Names every object answers and a renderer or a serializer may ask for: never a parameter. */
const isProbe = (name: string): boolean =>
  name in Object.prototype || name === 'then' || name === 'toJSON';

export function routeQuery(
  entry: RouteEntry,
  url: URL,
  env?: ResolveEnvironmentOptions['env'],
): Query {
  const query: Query = Object.fromEntries(url.searchParams);
  const declared = entry.config.render === 'isr' ? entry.config.revalidate?.query : undefined;
  if (declared === undefined) return query;
  // Production pays nothing: the plain object, no trap. (`undefined`: an unreadable environment,
  // which is not a development one either.)
  const environment = tryResolveEnvironment(env === undefined ? undefined : { env });
  if (environment === 'production' || environment === undefined) return query;
  return new Proxy(query, {
    get(target, name, receiver) {
      if (typeof name === 'string' && !declared.includes(name) && !isProbe(name)) {
        const key = `${entry.file}\u0000${name}`;
        if (!told.has(key)) {
          told.add(key);
          const widened = [...declared, name].sort().map((one) => `'${one}'`);
          logger.warn('isr.query.unkeyed-read', {
            route: entry.file,
            param: name,
            cause: `the page read query.${name}, and revalidate.query does not list it — the stored page is keyed without it, so every visitor gets the document rendered for whichever value arrived first`,
            fix: `query: [${widened.join(', ')}]   // in revalidate, in ${entry.file}`,
          });
        }
      }
      return Reflect.get(target, name, receiver);
    },
  });
}
