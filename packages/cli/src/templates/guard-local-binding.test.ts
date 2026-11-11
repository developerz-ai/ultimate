// The spliced `bindsLocally()` source stays ASCII, and so does every shipped guard as emitted. Bun
// escapes a non-ASCII character in a template literal and `String.raw` keeps the escape, so a `—`
// in `LOCAL_BINDING_SOURCE` reached three apps' `guards/*.ts` as the six characters `—`.

import { describe, expect, test } from 'bun:test';
import { LOCAL_BINDING_SOURCE } from './guard-local-binding';
import { SHIPPED_GUARD_NAMES, shippedGuardFiles } from './scaffold-guards';

/** A `\uXXXX` escape of a character above ASCII — what `String.raw` leaves of one. */
const ESCAPED_NON_ASCII =
  /\\u(?:00[89a-fA-F][0-9a-fA-F]|0[1-9a-fA-F][0-9a-fA-F]{2}|[1-9a-fA-F][0-9a-fA-F]{3})/;

describe('emitted guard source', () => {
  test('the spliced binding source is ASCII only, with no escape standing in for a character', () => {
    expect(LOCAL_BINDING_SOURCE).not.toMatch(/[^\t\n\r -~]/);
    expect(LOCAL_BINDING_SOURCE).not.toMatch(ESCAPED_NON_ASCII);
  });

  test('no shipped guard file carries an escaped non-ASCII character', () => {
    const offenders = SHIPPED_GUARD_NAMES.flatMap((name) =>
      (shippedGuardFiles(name) ?? [])
        .filter(
          (file) => typeof file.contents === 'string' && ESCAPED_NON_ASCII.test(file.contents),
        )
        .map((file) => file.path),
    );
    expect(offenders).toEqual([]);
  });
});
