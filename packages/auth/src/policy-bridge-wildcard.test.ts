// An API key keeps only what its owner could do — and an owner holding `billing:invoice:*` cannot
// issue refunds. Reading the wildcard by its first segment let such a key keep
// `billing:refund:issue`, reaching further than the account that minted it.
import { describe, expect, test } from 'bun:test';
import { apiKeyScopes } from './policy-bridge';

describe('apiKeyScopes cuts a key to its owner by the wildcard PREFIX', () => {
  test('an owner with billing:invoice:* keeps invoice scopes and loses refund scopes', () => {
    const scopes = ['billing:invoice:read', 'billing:refund:issue'];
    expect(apiKeyScopes(scopes, ['billing:invoice:*'])).toEqual(['billing:invoice:read']);
  });

  test('a one-level wildcard still reaches every depth under its resource', () => {
    const scopes = ['billing:invoice:read', 'billing:refund:issue', 'post:read'];
    expect(apiKeyScopes(scopes, ['billing:*'])).toEqual([
      'billing:invoice:read',
      'billing:refund:issue',
    ]);
  });
});
