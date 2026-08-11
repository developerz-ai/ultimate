// Handover. `defineApi` is the ONE registration call, and handing the two modules over here is what
// names them: a job module nothing hands over keeps `job()`'s positional `anonymous-job-<n>` — on
// every queue row, in every dead-letter trace and in `x tasks list`. Jobs before tasks is
// `defineApi`'s own ordering, because a task descriptor lists the jobs it enqueues by name.

import { defineApi } from '@ultimat3/action';
import * as taskJobs from '../app/tasks/jobs';
import * as taskSchedule from '../app/tasks/schedule';

export const scheduledApi = defineApi({ jobs: taskJobs, tasks: taskSchedule });
