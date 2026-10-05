// The feature refusals' `fix:` lines are pasted into a shell, so a value spliced into one is
// screened. Plan 101 row S12: `x db gen "search ${name}"` sat behind a sentence the shell-arg guard
// read as prose, and a `$(…)` in the name ran when the line was pasted.

import { describe, expect, test } from 'bun:test';
import { searchUndeclared } from './feature-errors';

describe('searchUndeclared', () => {
  test('an ordinary entity name reaches the command verbatim', () => {
    expect(searchUndeclared('posts').fix).toContain('x db gen "search posts"');
  });

  test('a name carrying shell syntax is never spliced into the command', () => {
    // The sentence before `then:` names the entity and is never run; the command after it is.
    const command = searchUndeclared('posts$(touch pwned)').fix.split('then: ')[1];
    expect(command).toBe('x db gen "search <entity>"');
  });
});
