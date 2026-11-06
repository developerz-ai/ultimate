// `frameworkSources` projects each `defineSubject()` as a fact: the treatment's kind, its columns
// or reason, never the anonymized values — those are code, not contract.

import { afterEach, expect, test } from 'bun:test';
import type { Driver, EntityCore } from '@ultimat3/entity';
import { defineSubject, resetSubjects } from '@ultimat3/jobs';
import { frameworkSources } from './sources';

afterEach(resetSubjects);

test('a declared subject is projected kind by kind, its values left in code', () => {
  defineSubject({ $name: 'member' } as unknown as EntityCore, {
    driver: {} as Driver,
    key: (input: { readonly memberId: string }) => input.memberId,
    tables: {
      member: 'delete',
      comment: { anonymize: { authorName: 'deleted user', authorId: null } },
      invoice: { retain: 'tax law: 10 years' },
    },
    columns: { audit: 'actorId' },
  });
  const subjects = frameworkSources({ app: { name: 'acme', version: '1.0.0' } }).subjects;
  expect(subjects).toEqual([
    {
      entity: 'member',
      batch: 200,
      tables: [
        { entity: 'member', treatment: 'delete' },
        { entity: 'comment', treatment: 'anonymize', columns: ['authorName', 'authorId'] },
        { entity: 'invoice', treatment: 'retain', reason: 'tax law: 10 years' },
      ],
      targets: [],
      links: [{ entity: 'audit', column: 'actorId' }],
    },
  ]);
  expect(JSON.stringify(subjects)).not.toContain('deleted user');
});
