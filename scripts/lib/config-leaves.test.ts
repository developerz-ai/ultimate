// A section typed through a namespace import (`clientErrors.ClientErrorsConfig`) and declared in
// its own file is still a section: the walk descends into it, so its keys are asked for readers and
// documented keys under it are recognised, rather than the whole block counting as one leaf.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { configDeclaration, configLeaves } from './config-leaves';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('configLeaves', () => {
  test('descends into a namespace-qualified section type, optional or not', () => {
    const source = [
      'export interface AppConfig {',
      '  readonly assets?: assetsSection.AssetsConfig | undefined;',
      '  readonly clientErrors: clientErrors.ClientErrorsConfig;',
      '}',
      'export interface AssetsConfig {',
      '  readonly retain: RetainConfig | undefined;',
      '}',
      'export interface RetainConfig {',
      '  readonly disk: string;',
      '}',
      'export interface ClientErrorsConfig {',
      '  readonly enabled: boolean;',
      '}',
    ].join('\n');
    expect(configLeaves(source)).toEqual(['assets.retain.disk', 'clientErrors.enabled']);
  });

  test('the real declaration reads the assets and clientErrors files', async () => {
    const leaves = configLeaves(await configDeclaration(repoRoot()));
    expect(leaves).toContain('assets.retain.disk');
    expect(leaves).toContain('assets.retain.builds');
    expect(leaves).toContain('clientErrors.perMinute');
  });
});
