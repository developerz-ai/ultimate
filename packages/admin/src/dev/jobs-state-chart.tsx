// The `/_x` jobs tab's opening ring: the recent runs this panel read, by state — ui's own
// `DonutChart`, server markup with a hidden data table. Only ever reached by `panel-jobs.ts`'s
// dynamic `import()`, so `/_x`'s mount graph loads no Solid until the jobs tab is opened.

import { ctxOf, runWithContext } from '@ultimat3/core';
import { renderToHtml } from '@ultimat3/render/server';
import { DonutChart } from '@ultimat3/ui';
import { t } from './dev-t';
import type { JobRunFact } from './facts';
import type { JobsPanelData } from './panel-jobs';

/** Every state a run can be in, in the order the ring and its legend draw them. */
const RUN_STATES: readonly JobRunFact['status'][] = ['ok', 'running', 'failed', 'dead'];

/**
 * The ring as HTML, or `''` when no run has been recorded: an empty circle reads as a broken chart,
 * and the overview below already says the queue is idle. The framework's locale and UTC, stated
 * rather than ambient — `/_x` is the framework's tool.
 */
export async function jobsStateHtml(data: JobsPanelData): Promise<string> {
  if (data.runs.length === 0) return '';
  const counts = RUN_STATES.map((state) => ({
    label: t(`dev.panel.jobs.state.${state}`),
    value: data.runs.filter((run) => run.status === state).length,
  }));
  return runWithContext(ctxOf({ locale: 'en', tz: 'UTC' }), () =>
    renderToHtml(
      <DonutChart
        label={t('dev.panel.jobs.chart.label')}
        showCaption
        segments={counts}
        centreLabel={t('dev.panel.jobs.chart.total')}
        keyLabel={t('dev.panel.jobs.chart.state')}
        valueLabel={t('dev.panel.jobs.chart.runs')}
      />,
    ),
  );
}
