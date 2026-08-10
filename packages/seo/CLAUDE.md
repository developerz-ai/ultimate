# @ultimat3/seo — agent notes

Tier 1. May import `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`. Nothing above tier 1, no external deps.

## Boundary

| Owns | Does not own |
|---|---|
| metadata model, the build gate, JSON-LD, sitemap/robots/feeds, image contract, budgets | rendering, routing, the route table itself (it consumes `RouteRecord`) |

## Hard rules

- **Enforced, not documented.** Every check has an `assert*` that throws a coded `SeoError`, and a `--json`-shaped report the CLI prints. A check that only returns a boolean does not exist.
- **Errors name the file, not the URL.** `RouteRecord.file` is in every cause and every fix; an agent must be able to open the source without guessing.
- **Fail closed.** `resolveEnvironment()` returns `preview` for anything that is not literally `production`. Never invert that default.
- **Required schema.org fields are required in the input type.** Runtime `required()` only catches empty strings from a CMS; the type is the primary gate.
- **No ambient defaults for meta.** A missing description is an error, never a fallback string.
- **`builtinImageDriver({ read })` takes its reader.** `TransformRequest.src` is a string, and
  whether that string is a path, a storage key or a URL is the app's fact, not seo's — never add
  a filesystem fallback. Pixels come from `@ultimat3/core`'s pipeline; seo owns no second scaler,
  and the driver reports the size it probed off the output, never the size that was requested.
- Only `site/` routes are SEO-checked — `app/` is behind auth and crawlers never authenticate.

## Files

| Path | Responsibility |
|---|---|
| `routes.ts` | the `RouteRecord` shape + `indexableRoutes` / `expandRoute` |
| `meta.ts` | model + `renderMeta()`; the only place head tags are constructed |
| `validate.ts` | the gate; `MetaIssue` is the serialisable projection of a `SeoError` |
| `xml.ts` | all escaping. Never hand-roll an escape in another module |
| `images.ts` | what the markup promises: `srcset` widths, `<picture>` order, inlined dimensions. Decodes nothing |
| `image-driver.ts` | the bytes behind that promise: `ImageTransformDriver` + `builtinImageDriver({ read })` over core's pipeline — png/jpeg only |

## Commands

```
bun test packages/seo
bun run --filter @ultimat3/seo typecheck
```
