// Single responsibility: screen the prompt-cache rows an app declares on a provider, at
// construction, against what that provider's wire can speak. A row the wire cannot honour would
// be a 400 on every hinted call, so it is refused at boot rather than sent.

import { renderCauseValue } from '@ultimat3/core';
import { AiRequestInvalidError } from './errors';
import type { CacheWire, ProviderCacheRow, ProviderPromptCache } from './prompt-cache';

interface WireSpeaks {
  readonly factory: string;
  readonly marks: readonly ProviderCacheRow['marks'][];
  readonly session: readonly ProviderCacheRow['session'][];
}

/** What each wire carries: Messages has no session carrier; chat-completions has two. */
const SPEAKS: ReadonlyMap<CacheWire, WireSpeaks> = new Map<CacheWire, WireSpeaks>([
  ['anthropic', { factory: 'anthropicProvider', marks: ['blocks', 'none'], session: ['none'] }],
  [
    'openai',
    {
      factory: 'openAiProvider',
      marks: ['parts', 'none'],
      session: ['x-session-id', 'prompt_cache_key', 'none'],
    },
  ],
]);

/** The rows, screened; `[]` for no option. Reads `unknown` because plain JS reaches here too. */
export function screenCacheRows(
  wire: CacheWire,
  option: ProviderPromptCache | undefined,
): readonly ProviderCacheRow[] {
  if (option === undefined) return [];
  const speaks = SPEAKS.get(wire);
  if (speaks === undefined) return [];
  const rules: unknown = (option as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw refusal(speaks, `promptCache.rules is ${renderCauseValue(rules)}, not an array of rows`);
  }
  return rules.map((row: unknown, index) => screenRow(speaks, row, index));
}

function screenRow(speaks: WireSpeaks, row: unknown, index: number): ProviderCacheRow {
  if (typeof row !== 'object' || row === null) {
    throw refusal(speaks, `promptCache.rules row ${index} is ${renderCauseValue(row)}, not a row`);
  }
  const { model, marks, session } = row as Record<'model' | 'marks' | 'session', unknown>;
  if (typeof model !== 'string') {
    throw refusal(
      speaks,
      `promptCache.rules row ${index} has model ${renderCauseValue(model)}; a model is an id prefix string ('' is every model)`,
    );
  }
  const mark = speaks.marks.find((known) => known === marks);
  if (mark === undefined) {
    throw refusal(
      speaks,
      `promptCache.rules row ${index} has marks ${renderCauseValue(marks)}; ${speaks.factory}()'s wire speaks marks ${quoted(speaks.marks)}`,
    );
  }
  const carrier = speaks.session.find((known) => known === session);
  if (carrier === undefined) {
    throw refusal(
      speaks,
      `promptCache.rules row ${index} has session ${renderCauseValue(session)}; ${speaks.factory}()'s wire carries a session as ${quoted(speaks.session)}`,
    );
  }
  return { model, marks: mark, session: carrier };
}

function refusal(speaks: WireSpeaks, detail: string): AiRequestInvalidError {
  const marks = speaks.marks[0] ?? 'none';
  const session = speaks.session[0] ?? 'none';
  return new AiRequestInvalidError({
    detail,
    fix: `${speaks.factory}({ …, promptCache: { rules: [{ model: '<id prefix>', marks: '${marks}', session: '${session}' }] } })   # marks ${quoted(speaks.marks)}; session ${quoted(speaks.session)}`,
  });
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' or ');
}
