/** Business-rule error codes. Each one names the fix, because agents read these, not stack traces. */

import { UltimateError } from '@ultimat3/core';

export class CoreError extends UltimateError {}

export class SeatsExceeded extends CoreError {
  constructor(details: { plan: string; limit: number; requested: number }) {
    super({
      code: 'X_BILLING_SEATS_EXCEEDED',
      cause: `plan "${details.plan}" allows ${details.limit} seats; ${details.requested} requested`,
      fix: 'call upgradePlan before inviteMember, or remove a member first',
      docs: 'https://ultimate.dev/errors/X_BILLING_SEATS_EXCEEDED',
    });
  }
}

export class NotAnUpgrade extends CoreError {
  constructor(details: { from: string; to: string }) {
    super({
      code: 'X_BILLING_NOT_AN_UPGRADE',
      cause: `"${details.from}" → "${details.to}" is not an upgrade; downgrades and refunds are a separate flow`,
      fix: 'use the scheduled-downgrade flow so the current period is honoured',
      docs: 'https://ultimate.dev/errors/X_BILLING_NOT_AN_UPGRADE',
    });
  }
}
