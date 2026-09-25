# Static assets

**A public file lives in `apps/web/site/assets/`, and a page names it with `asset()`.** One call
returns a content-hashed URL, served `public, max-age=31536000, immutable` by `x dev` and the
container alike, and copied into the static export under the same name. `As of 2026-09-25` (22.3.0).

```tsx
import { asset } from '@ultimat3/render';
import { Image } from '@ultimat3/ui';

<Image
  src={asset('assets/hero-1280.jpg')}
  alt=""
  width={1280}
  height={720}
  sizes="(max-width: 700px) 100vw, 1280px"
  priority
  sources={{
    avif: [
      { src: asset('assets/hero-640.avif'), width: 640 },
      { src: asset('assets/hero-1280.avif'), width: 1280 },
    ],
    webp: [
      { src: asset('assets/hero-640.webp'), width: 640 },
      { src: asset('assets/hero-1280.webp'), width: 1280 },
    ],
  }}
/>
```

`asset('assets/hero-640.avif')` → `/assets/hero-640.3f2a1b9c.avif`.

## The rules

| Rule | Enforced by |
|---|---|
| the path starts with `assets/` and ends in a served extension | the type: `AssetPath` is `` `assets/${string}.${AssetExtension}` ``, so `asset('hero.avif')` and `asset('assets/x.txt')` are TS2345 |
| the file exists | `X_ASSET_MISSING`, thrown while the page renders, so `x build --target static` fails on it and `x dev` shows it |
| no `..`, no empty segment, no backslash | `assetPathProblem()`, the same check in the page, the table and the route |
| only the hashed URL is served | `/assets/hero.avif` is 404; so is a hash that no longer matches the bytes (a document from an earlier build) |
| the URL changes when the bytes change | the hash is xxHash32 of the file, re-read when its mtime or size changes, with no watcher and no restart |

Call `asset()` in a page or a server component, never in an island. A browser has no asset table, so
there it throws `X_ASSET_MISSING`: pass the URL to the island as a prop instead.

## Served types

| Extension | `content-type` |
|---|---|
| `avif` | `image/avif` |
| `webp` | `image/webp` |
| `png` | `image/png` |
| `jpg`, `jpeg` | `image/jpeg` |
| `gif` | `image/gif` |
| `svg` | `image/svg+xml` |
| `ico` | `image/x-icon` |
| `woff2` | `font/woff2` |
| `mp4` | `video/mp4` |
| `webm` | `video/webm` |
| `vtt` | `text/vtt; charset=utf-8` |

Any other file under `assets/` (a `.psd`, a `README.md`) is not served and not copied.

**Byte ranges are answered.** `Range: bytes=…` gets a `206` with `content-range`, and an
unsatisfiable range gets a `416`. Safari will not play a `<video>` without this.

## Where it happens

| Question | Answer |
|---|---|
| the table | `packages/cli/src/site-assets.ts`: one table per app root, installed into `asset()` by `loadApp` |
| the route | `packages/cli/src/site-asset-routes.ts`: `GET /assets/*file`, mounted by `assetRoutes()`, which both `x dev` and the container compose |
| the export | `writeSiteAssets(root, out)` copies every asset to `out/assets/…/<name>.<hash>.<ext>` |
| the helper | `packages/render/src/asset.ts`: `asset()`, `setAssetResolver()`, `assetPathProblem()` |

`favicon.ico` stays at `apps/web/site/favicon.ico` and the install icon at `apps/web/site/icon.png`.
Browsers ask for those at fixed URLs, so they are not hashed.

## `<Image>`

| Prop | Meaning |
|---|---|
| `src` | the fallback rendition every browser decodes |
| `alt` | required. `""` for a decorative image, on purpose |
| `width` + `height`, **or** `aspectRatio` (`'16 / 9'`) | required. A box is always reserved: neither, one dimension alone, or both forms together is `X_UI_INVALID_VALUE` |
| `variants` | widths (or densities) of `src`'s own encoding, rendered as the `<img>`'s `srcset` |
| `sources` | `{ avif?, webp? }`, each a width list. Renders a `<picture>` with AVIF first, then WebP, then the `<img>` |
| `sizes` | applies to every set |
| `priority` | the LCP image: `loading="eager"` + `fetchpriority="high"`. At most one per route. Never lazy |

Everything else is `loading="lazy"`, `fetchpriority="auto"` and `decoding="async"`.

## In a unit test

A test that renders a page calling `asset()` without loading the app installs a table itself:

```ts
import { setAssetResolver } from '@ultimat3/render';

beforeAll(() => setAssetResolver((path) => `/${path}`));
afterAll(() => setAssetResolver(undefined));
```

## Screenshots

`x shot <route> --locale en` photographs `/en/<route>` with `Accept-Language: en`. With no
`--locale`, `Accept-Language` is still pinned to the app's default locale. `x shot --matrix`
photographs every site route in every locale, in light and dark, at 390 and 1440 px, into
`.x/shot/matrix/`, with an `index.html` contact sheet. See [CLI reference](CLI-Reference#x-shot).
