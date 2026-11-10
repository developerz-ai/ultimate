// The two `X_LEDGER_*` refusals a posting can end on — both about the POSTING, raised before a line
// is written, so a refused posting leaves the book exactly as it was. Amounts and accounts are the
// app's own strings and integers; nothing `unknown` is interpolated (`describeValue` renders those).

import { UltimateError } from '@ultimat3/core';
import { describeValue } from '@ultimat3/schema';
import './error-codes';

/** One entry, or the posting's shape, is not something a balanced book can hold. */
export class LedgerEntryInvalidError extends UltimateError {
  constructor(input: { key: string; index: number | null; field: string; got: unknown }) {
    const where = input.index === null ? 'the posting' : `entries[${input.index}]`;
    super({
      code: 'X_LEDGER_ENTRY_INVALID',
      cause: `ledger posting ${JSON.stringify(input.key)}: ${where}.${input.field} is ${describeValue(input.got)}`,
      fix: `{ account: 'cash', amount: { minor: 1299, currency: 'EUR' } }   # ${where} in the enqueue of the ledger job: a named account, integer minor units (fromDecimal('12.99', 'EUR') from @ultimat3/money), at least two entries`,
      meta: { key: input.key, index: input.index, field: input.field },
    });
  }
}

/** The entries of one currency do not net to zero. `net` is that currency's sum, in minor units. */
export class LedgerUnbalancedError extends UltimateError {
  constructor(input: { key: string; currency: string; net: number }) {
    super({
      code: 'X_LEDGER_UNBALANCED',
      cause: `ledger posting ${JSON.stringify(input.key)} nets ${input.net} minor units of ${input.currency}, not zero — every currency's entries must sum to zero`,
      fix: `{ account: '<balancing account>', amount: { minor: ${-input.net}, currency: '${input.currency}' } }   # one more entry in the posting's entries, or correct the amounts`,
      meta: { key: input.key, currency: input.currency, net: input.net },
    });
  }
}

/** A key already stored with other lines: writing beside them would unbalance the book. */
export class LedgerPostingConflictError extends UltimateError {
  constructor(input: { key: string; stored: number; incoming: number; line: number | null }) {
    const differs =
      input.line === null
        ? `holds ${input.stored} line(s) and this posting has ${input.incoming}`
        : `holds another line ${input.line}`;
    super({
      code: 'X_LEDGER_POSTING_CONFLICT',
      cause: `ledger posting ${JSON.stringify(input.key)} is already in the book and ${differs} — a key names one posting, and its lines never change`,
      fix: `{ key: ${JSON.stringify(`${input.key}:adjust-1`)}, entries: [ … ] }   # the posting in the enqueue of the ledger job: a correction under a new key, or the entries exactly as first posted`,
      meta: { key: input.key, stored: input.stored, incoming: input.incoming, line: input.line },
    });
  }
}
