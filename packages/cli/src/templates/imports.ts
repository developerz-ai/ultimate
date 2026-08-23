// The order Biome's `organizeImports` wants for a generated file — COMPUTED, because it depends on
// the app's own scope and no fixed order can be right for every app.
//
// `import { useT } from '@myapp/i18n'` sorts BEFORE `@ultimat3/render`; `@zebra/i18n` sorts after
// it. Every template wrote one fixed order, so `x new zebra` scaffolded four files Biome refuses
// (`assist/source/organizeImports`, measured: `apps/web/site/page.tsx`,
// `apps/web/app/dashboard/page.tsx`, `apps/admin/app/admin/page.tsx`, `packages/mcp/src/index.ts`)
// and the app's very first `x verify` was red on its `lint` step. `x new alpha` was clean, which is
// why nothing caught it: both CI fixtures — `demoapp` and `bareapp` — sort before `ultimat3`.
//
// `templates/admin-page.ts` already did this by hand for its two lines; this is that sort, in one
// place, for every generator that mixes an app specifier with a framework one.

/** The quoted specifier a line imports from — the only thing Biome orders these lines by. */
const specifierOf = (line: string): string => line.slice(line.indexOf("'"));

/**
 * One import block, sorted the way Biome would sort it.
 *
 * BARE specifiers only (`@myapp/i18n`, `@ultimat3/render`, `solid-js`). A relative specifier
 * (`./page.module.scss`) belongs to a LATER group and sorts before every `@` by plain string
 * compare, so passing one here would emit the block Biome then moves — the exact defect this
 * exists to end. Templates write those lines after the block, where they already are.
 */
export const sortedImports = (lines: readonly string[]): string =>
  [...lines].sort((a, b) => (specifierOf(a) < specifierOf(b) ? -1 : 1)).join('\n');
