// An erased author is shown as the catalog's label, in the reader's locale, never as the stored
// placeholder; anyone else's name is shown as stored.

import { ERASED_MEMBER_NAME } from '@postly/domain';
import '@postly/i18n';
import { translatorFor } from '@ultimat3/i18n';
import { expect, unitTest } from '@ultimat3/testing';
import { memberName } from './member-name';

const translator = (locale: 'en' | 'es') => (key: 'common.formerMember') =>
  translatorFor(locale)(key);

unitTest('an erased member renders the former-member label in each shipped locale', () => {
  expect(memberName(translator('en'), ERASED_MEMBER_NAME)).toBe('Former member');
  expect(memberName(translator('es'), ERASED_MEMBER_NAME)).toBe('Antiguo miembro');
});

unitTest('a member who was not erased renders their own name', () => {
  expect(memberName(translator('en'), 'Ada')).toBe('Ada');
});
