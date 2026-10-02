// An action's label key, spelled once. The button, its form, the batch bar, the batch result and
// `catalogKeys()` all read it here, so the key a screen draws and the key the `i18n` step asks a
// catalog for cannot be two spellings of one rule.

import type { AdminAction } from './registry';

/** `labelKey` when the action names one, else `admin.action.<name>` — its MCP tool's name too. */
export const actionLabelKey = (action: Pick<AdminAction, 'name' | 'labelKey'>): string =>
  action.labelKey ?? `admin.action.${action.name}`;
