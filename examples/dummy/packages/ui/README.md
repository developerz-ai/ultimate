# @postly/ui

Three components Postly needs and `@ultimat3/ui` should not have an opinion about.

| Component | Renders | Used by |
|---|---|---|
| `PostCard` | title, excerpt, author, date in the viewer's zone, like count, a slot for actions | `site/blog`, `app/feed` |
| `OrgSwitcher` | the actor's orgs as a native `<select>` | `app/layout`, `apps/admin` |
| `PlanBadge` | plan name + monthly price in the org's currency | `site/pricing`, `app/settings`, `apps/admin` |

## Rules these components obey

| Rule | Why |
|---|---|
| No fetching, no actions, no policy checks | a component that loads data cannot be reused on the static surface |
| Every string via `useT()` | `site/` is prerendered per locale; a hardcoded string breaks one of them silently |
| Every colour a `var(--color-*)` token | dark theme is a token flip, not a second stylesheet |
| Every date through `<DateTime zone={…}>` | the zone is a required prop, so it cannot be forgotten |
| Every price through `<Money>` | formatting happens once, at the edge |
| SCSS modules only | build-time styles, zero runtime, no class-name collisions |
| Byte budget | these ship to `site/`, so they live under the same budget as `shared/` — no charting library, no date library |

## Composition, not configuration

`PostCard` takes an `actions` slot instead of an `onLike` prop. The static blog passes nothing;
the post page passes `<LikeButton likeCount={…}>` from `apps/web/app/posts/ui/`. That is what keeps
the mutator — and its offline queue — out of the 0kb surface.

```tsx
<PostCard post={post} href={`/blog/${post.slug}`} zone={viewer.tz} />
<PostCard post={post} href={`/posts/${post.id}`} zone={viewer.tz} actions={<LikeButton likeCount={post.likeCount} />} />
```

`<LikeButton>` is the SERVER's half — the count, and a button it cannot honour. The interactive one
is `apps/web/app/posts/[id]/like.island.tsx`, which the post page declares with `island()` and which
replaces this markup once a browser has booted it. A component calling `useMutation()` on a route
with no island is `X_LIVE_ROUTE_NO_ISLAND`, which is where that split came from.
