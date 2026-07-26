# @postly/ui

App components on `@ultimat3/ui`. Presentational only.

## Boundary

| May import | Must never |
|---|---|
| `@ultimat3/ui`, `@postly/i18n`, `@postly/domain`, `solid-js` | `@postly/db`, `@postly/core`, `apps/*`, any action, query or mutator |

Ships to `site/`, so it carries the same byte budget as `shared/`. Adding a dependency here can
turn the landing page's bundle from 0kb into a build failure — that is the intended feedback.

## Files

| File | Owns |
|---|---|
| `src/post-card.tsx` + `.module.scss` | the post summary card |
| `src/org-switcher.tsx` + `.module.scss` | org selection, native `<select>`, works with 0kb JS |
| `src/plan-badge.tsx` + `.module.scss` | plan name + price |

## Conventions

- Props are `readonly`; a component never mutates what it is given.
- Data comes in as props. If a component needs to load something, it is in the wrong package.
- Interactivity that needs an action/mutator goes in a slot prop (`actions`), filled by
  `apps/web/app/<feature>/ui/`.
- Class names come from the `.module.scss` next to the component. No global selectors, no `!important`.

## Gotchas

- `<DateTime>` requires `zone`. Pass the viewer's `member.tz`, never the server's.
- `OrgSwitcher` submits a native form so it keeps working on a `hydrate: 'never'` route.
