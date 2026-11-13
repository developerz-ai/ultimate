// Every metric name a package declares: each literal passed to `counter(`, `gauge(` or
// `histogram(` in non-test source, plus the semconv names declared through `SEMCONV_METRICS`.
// What the chart's alert rules and its dashboard are held to, so a renamed series is red.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { SEMCONV_METRICS } from '../../packages/core/src/instrument-semconv';

const DECLARATION = /\b(?:counter|gauge|histogram)\(\s*'([a-z_:][a-z0-9_:]*)'/g;

export async function declaredSeries(root: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>(Object.values(SEMCONV_METRICS));
  const glob = new Bun.Glob('packages/*/src/**/*.ts');
  for await (const path of glob.scan({ cwd: root })) {
    if (path.endsWith('.test.ts') || path.includes('.contract.') || path.includes('.live.')) {
      continue;
    }
    const text = await Bun.file(join(root, path)).text();
    for (const match of text.matchAll(DECLARATION)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

/** A histogram's exposition suffixes: `<name>_bucket` is the series `histogram('<name>')` writes. */
export const HISTOGRAM_SUFFIX = /_(?:bucket|sum|count)$/;

/** True when `series` is declared, as itself or as the histogram it is a suffix of. */
export const isDeclared = (series: string, declared: ReadonlySet<string>): boolean =>
  declared.has(series) || declared.has(series.replace(HISTOGRAM_SUFFIX, ''));
