// `UserStore`'s identity rules for `authAdapterConformance`: an address is looked up exactly as it
// is stored (normalisation is `normaliseEmail`'s, above the seam), and a duplicate id, email or
// external id is refused as `X_AUTH_WRITE_FAILED` — NULLS DISTINCT, as a Postgres unique index is.

import { expect } from 'bun:test';
import type { AuthAdapterCheck } from './auth-adapter-conformance-support';
import { emailOf, idOf, refusal, userId, userInput } from './auth-adapter-conformance-support';

const DISABLED_AT = new Date('2026-08-09T12:00:01.000Z');

export const AUTH_ADAPTER_USER_CHECKS: readonly AuthAdapterCheck[] = [
  {
    name: 'an address is stored as handed and looked up exactly, case and spaces included',
    async run({ adapter }) {
      const [id, padded] = [userId(), userId()];
      const email = emailOf('ada');
      await adapter.createUser(userInput(id, email));
      expect((await adapter.findUserByEmail(email))?.id).toBe(id);
      expect(await adapter.findUserByEmail(email.toUpperCase())).toBeNull();
      const spaced = ` ${emailOf('Grace').toUpperCase()} `;
      await adapter.createUser(userInput(padded, spaced));
      expect((await adapter.findUserById(padded))?.email).toBe(spaced);
    },
  },
  {
    name: 'two spellings of one address are two accounts',
    async run({ adapter }) {
      const email = emailOf('ada');
      await adapter.createUser(userInput(userId(), email));
      const second = userId();
      await adapter.createUser(userInput(second, email.toUpperCase()));
      expect((await adapter.findUserByEmail(email.toUpperCase()))?.id).toBe(second);
    },
  },
  {
    name: 'a second account at one email is refused, and neither row moves',
    async run({ adapter }) {
      const [first, second] = [userId(), userId()];
      const email = emailOf('dup');
      await adapter.createUser(userInput(first, email, { passwordHash: 'hash' }));
      expect(await refusal(adapter.createUser(userInput(second, email)))).toBe(
        'X_AUTH_WRITE_FAILED createUser email',
      );
      expect((await adapter.findUserById(first))?.passwordHash).toBe('hash');
      expect(await adapter.findUserById(second)).toBeNull();
    },
  },
  {
    name: 'a second account at one id is refused, and the first keeps its address',
    async run({ adapter }) {
      const id = userId();
      const email = emailOf('id');
      await adapter.createUser(userInput(id, email));
      expect(await refusal(adapter.createUser(userInput(id, emailOf('other'))))).toBe(
        'X_AUTH_WRITE_FAILED createUser id',
      );
      expect((await adapter.findUserById(id))?.email).toBe(email);
    },
  },
  {
    name: 'a second account at one external id is refused; any number may hold none',
    async run({ adapter }) {
      const externalId = idOf('okta');
      const [first, second, third] = [userId(), userId(), userId()];
      await adapter.createUser(userInput(first, emailOf('a'), { externalId }));
      expect(
        await refusal(adapter.createUser(userInput(second, emailOf('b'), { externalId }))),
      ).toBe('X_AUTH_WRITE_FAILED createUser external_id');
      await adapter.createUser(userInput(second, emailOf('b'), { externalId: null }));
      await adapter.createUser(userInput(third, emailOf('c'), { externalId: null }));
      expect((await adapter.findUserById(third))?.externalId).toBeNull();
      expect((await adapter.findUserByExternalId(externalId))?.id).toBe(first);
      expect(await adapter.findUserByExternalId(idOf('nobody'))).toBeNull();
    },
  },
  {
    name: "updateUser refuses another account's external id, and allows its own or none",
    async run({ adapter }) {
      const [ada, grace] = [userId(), userId()];
      const [adaExternal, graceExternal] = [idOf('abc'), idOf('def')];
      await adapter.createUser(userInput(ada, emailOf('a'), { externalId: adaExternal }));
      await adapter.createUser(userInput(grace, emailOf('g'), { externalId: graceExternal }));
      expect(await refusal(adapter.updateUser(grace, { externalId: adaExternal }))).toBe(
        'X_AUTH_WRITE_FAILED updateUser external_id',
      );
      expect((await adapter.findUserById(grace))?.externalId).toBe(graceExternal);
      expect((await adapter.updateUser(ada, { externalId: adaExternal }))?.externalId).toBe(
        adaExternal,
      );
      expect((await adapter.updateUser(ada, { externalId: null }))?.externalId).toBeNull();
      expect((await adapter.updateUser(grace, { externalId: null }))?.externalId).toBeNull();
    },
  },
  {
    name: 'updateUser writes what the patch names, leaves the rest, and answers null for nobody',
    async run({ adapter }) {
      const id = userId();
      await adapter.createUser(userInput(id, emailOf('patch'), { roles: ['editor'] }));
      const updated = await adapter.updateUser(id, {
        scopes: ['tenancy:cross'],
        passwordHash: 'h',
      });
      expect([updated?.roles, updated?.scopes, updated?.passwordHash]).toEqual([
        ['editor'],
        ['tenancy:cross'],
        'h',
      ]);
      expect(await adapter.updateUser(userId(), { passwordHash: 'h' })).toBeNull();
    },
  },
  {
    name: 'listUsersByOrg orders by byte, leaves disabled members out unless asked, filters by role',
    async run({ adapter }) {
      const orgId = userId();
      const [upper, lower, gone] = [userId(), userId(), userId()];
      await adapter.createUser(userInput(lower, emailOf('ada'), { orgId, roles: ['editor'] }));
      await adapter.createUser(userInput(upper, emailOf('Zed'), { orgId }));
      await adapter.createUser(userInput(gone, emailOf('bob'), { orgId }));
      await adapter.updateUser(gone, { disabledAt: DISABLED_AT });
      const ids = async (query?: Parameters<typeof adapter.listUsersByOrg>[1]) =>
        (await adapter.listUsersByOrg(orgId, query)).map((user) => user.id);
      // `Z` (0x5A) sorts before `a` (0x61): a byte order, never a locale's.
      expect(await ids()).toEqual([upper, lower]);
      expect(await ids({ includeDisabled: true })).toEqual([upper, lower, gone]);
      expect(await ids({ role: 'editor' })).toEqual([lower]);
    },
  },
];
