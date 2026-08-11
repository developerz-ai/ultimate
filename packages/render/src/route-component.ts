/**
 * Which export of a route module is its page. Named exports only (the repo forbids `default`), and
 * the generators do not agree on one name — `Page`, `HomePage`, `DashboardPage`, `AdminHome` all
 * ship today — so the rule is a fixed precedence, evaluated once, here.
 */

import type { JsxComponent } from './jsx';

/** The page component of a route module: a function of props, sync or async. */
export type RouteComponent = JsxComponent;

const isComponentExport = (name: string, value: unknown): value is RouteComponent =>
  typeof value === 'function' && /^[A-Z]/.test(name);

/**
 * `Page` first, because that is the name `examples/dummy` uses and the one the generators should
 * converge on; then a single `…Page`; then a single capitalised function. Sorted before the last
 * fallback so a module with two components resolves to the same one on every machine.
 */
export function pageComponentOf(
  module: Readonly<Record<string, unknown>>,
): RouteComponent | undefined {
  const components = Object.entries(module)
    .filter(([name, value]) => isComponentExport(name, value))
    .sort(([a], [b]) => a.localeCompare(b)) as readonly (readonly [string, RouteComponent])[];
  if (components.length === 0) return undefined;

  const exact = components.find(([name]) => name === 'Page');
  if (exact !== undefined) return exact[1];

  const suffixed = components.filter(([name]) => name.endsWith('Page'));
  const onlySuffixed = suffixed.length === 1 ? suffixed[0] : undefined;
  if (onlySuffixed !== undefined) return onlySuffixed[1];

  return components[0]?.[1];
}
