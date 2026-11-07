// Summary: `summarize`, an `llm()`, read as it is written. The action declares `stream`, so its own
// route answers `text/event-stream` to `.stream(input)`: each token lands in the output as it
// arrives, and the validated answer replaces it at the end. No channel, no `EventSource`: the typed
// client's one transport, POST with the page's credentials and the action's own policy and budget.
//
// No Solid: a button, a live region and a loop over a generator. The page renders the button
// disabled — there is nothing to stream without scripting — and `mount` is what makes it work.

import type { Api } from '../../../api';
import { browserClient } from '../../../shared/browser-client';

type SummarizeInput = Parameters<Api['actions']['summarize']>[0];

/** Already translated by the server: a catalog cannot cross into an island. */
export interface SummaryProps {
  readonly postId: string;
  readonly orgId: string;
  readonly writingLabel: string;
  readonly failedLabel: string;
}

/** The disposer drops the click listener, so a router navigation leaves nothing listening. */
export function mount(el: HTMLElement, props: SummaryProps): () => void {
  const listening = new AbortController();
  const dispose = (): void => listening.abort();
  const button = el.querySelector('button');
  const output = el.querySelector<HTMLElement>('[data-role="summary"]');
  const status = el.querySelector<HTMLElement>('[data-role="status"]');
  if (button === null || output === null || status === null) return dispose;
  // The server rendered it disabled — both the attribute and what is announced.
  const usable = (on: boolean): void => {
    button.disabled = !on;
    button.setAttribute('aria-disabled', String(!on));
  };
  usable(true);

  button.addEventListener(
    'click',
    () => {
      usable(false);
      output.textContent = '';
      status.textContent = props.writingLabel;
      void read({ postId: props.postId, orgId: props.orgId }, output).then(
        (summary) => {
          // The answer that satisfied `output` replaces the raw tokens: they were the model's text,
          // this is the value the schema accepted.
          output.textContent = summary;
          status.textContent = '';
          usable(true);
        },
        () => {
          status.textContent = props.failedLabel;
          usable(true);
        },
      );
    },
    { signal: listening.signal },
  );
  return dispose;
}

/** Appends each token as it lands; resolves the validated summary. */
async function read(input: SummarizeInput, output: HTMLElement): Promise<string> {
  const stream = browserClient.summarize.stream(input);
  for (;;) {
    const step = await stream.next();
    if (step.done === true) return step.value.summary;
    output.textContent = `${output.textContent ?? ''}${step.value.text}`;
  }
}
