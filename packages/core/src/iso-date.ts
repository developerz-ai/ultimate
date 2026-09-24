// Single responsibility: re-export `@ultimat3/schema`'s ISO date-time predicate, so a package that
// depends on core and not on schema — `@ultimat3/ui` formats dates, it validates nothing — judges a
// date string with the ONE rule `t.date` and `timestamp()` use. The `time-zone-name.ts` shape.

export { isIsoDateTime } from '@ultimat3/schema';
