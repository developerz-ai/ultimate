// The pins a rendered document stamps (`@ultimat3/render`'s `clientPinTags`): every registered
// action and query that declares `http: { path }`, read off the registries per render, so a
// browser caller reaching one by NAME goes where the declaration put it — nothing restated.

import { actionHttpPinOf, describeActions, getAction } from '@ultimat3/action';
import type { ActionPin, ClientPins } from '@ultimat3/core';
import { describeQueries, getQuery, queryHttpPinOf } from '@ultimat3/query';

export function servedPins(): ClientPins {
  const actions: Record<string, ActionPin> = {};
  for (const { name } of describeActions()) {
    const target = getAction(name);
    const pin = target === undefined ? undefined : actionHttpPinOf(target);
    if (pin !== undefined) actions[name] = pin;
  }
  const queries: Record<string, string> = {};
  for (const { name } of describeQueries()) {
    const target = getQuery(name);
    const pin = target === undefined ? undefined : queryHttpPinOf(target);
    if (pin !== undefined) queries[name] = pin.path;
  }
  return { actions, queries };
}
