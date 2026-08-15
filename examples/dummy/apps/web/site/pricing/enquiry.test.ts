// The island's one decision, tested where a DOM is not needed: what a submitted form becomes on
// the wire, and when it becomes nothing at all. The `null` branch is the whole reason this rule is
// a function — it is what hands the submit back to the browser instead of posting a bad body.

import { expect, unitTest } from '@ultimat3/testing';
import { enquiryFrom } from './enquiry';

const full = [
  ['email', 'ada@example.com'],
  ['plan', 'team'],
  ['currency', 'EUR'],
  ['message', 'How many seats come with team?'],
  ['locale', 'es'],
] as const;

// Failure first: the whole reason this returns a union is that the island must be able to hand the
// submit back to the browser. A rule that always answered an object would post `{}` to the action
// and turn a renamed field into X_INPUT_INVALID in front of a visitor.
unitTest('an enquiry missing a field the action requires is refused, not repaired', () => {
  const withoutMessage = full.filter(([key]) => key !== 'message');
  expect(enquiryFrom(withoutMessage)).toBeNull();
});

unitTest('a field that is only whitespace counts as absent', () => {
  const blankMessage = full.map(([key, value]) => [key, key === 'message' ? '   ' : value]);
  expect(enquiryFrom(blankMessage)).toBeNull();
});

// A file input, or anything else a FormData can hold that is not text, is not a field this action
// takes — dropping it here is what keeps `JSON.stringify` from serializing it as `{}`.
unitTest('a non-string entry is dropped rather than serialized', () => {
  const withFile = [...full, ['attachment', new Uint8Array(1)]];
  expect(enquiryFrom(withFile)).toEqual({
    email: 'ada@example.com',
    plan: 'team',
    currency: 'EUR',
    message: 'How many seats come with team?',
    locale: 'es',
  });
});

unitTest('a complete form is trimmed into exactly the action’s input', () => {
  const padded = full.map(([key, value]) => [key, `  ${value}  `]);
  expect(enquiryFrom(padded)).toEqual({
    email: 'ada@example.com',
    plan: 'team',
    currency: 'EUR',
    message: 'How many seats come with team?',
    locale: 'es',
  });
});
