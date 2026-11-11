// `maintainPartitions` — one primitive per file, the layout `x g` writes.
//
// `partitions()` is a job factory, not a ninth primitive: every `entity({ partitionBy })` in the
// app — `quota_alerts` — gets its next months created ahead and its expired ones dropped, daily at
// 03:17 UTC by the `.schedule` task it carries. Without it, the first row past the last partition
// is Postgres' `23514`, and the oldest month is never dropped.

import { partitions } from '@ultimat3/jobs';

export const maintainPartitions = partitions();
