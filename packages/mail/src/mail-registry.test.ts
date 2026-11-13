// `restoreMails`: the mail registry put back to exactly what was read, so a test seam can forget
// one file's ids and keep every other module's — while `defineMail` still refuses a held id.

import { afterEach, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import { defineMail, registeredMailIds, registeredMails, restoreMails } from './mail';

const held = registeredMails();
afterEach(() => restoreMails(held));

const declare = (id: string) =>
  defineMail<Record<string, never>>({
    id,
    input: t.object({}),
    subject: 'test.restore.subject',
    template: () => [blocks.paragraph('test.restore.body')],
  });

describe('restoreMails', () => {
  test('the registry becomes exactly what was handed back: a forgotten id declares afresh', () => {
    const kept = declare('restore-kept');
    declare('restore-forgotten');
    restoreMails(registeredMails().filter((mail) => mail.id !== 'restore-forgotten'));
    expect(registeredMailIds()).toEqual([...held.map((mail) => mail.id), 'restore-kept'].sort());
    expect(registeredMails().find((mail) => mail.id === 'restore-kept')).toBe(kept);
    expect(() => declare('restore-forgotten')).not.toThrow();
    expect(() => declare('restore-kept')).toThrow(
      expect.objectContaining({ code: 'X_MAIL_DUPLICATE' }),
    );
  });

  test('two definitions under one id are refused rather than one silently kept', () => {
    const first = declare('restore-twice');
    restoreMails([]);
    const second = declare('restore-twice');
    expect(() => restoreMails([first, second])).toThrow(
      expect.objectContaining({ code: 'X_MAIL_DUPLICATE' }),
    );
  });
});
