// Resources and prompts: stable URIs, on-demand reads (never eager), and the versioned-prompt
// naming rule (name + version suffix comes from the filename, never restated).

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { FrameworkResourceProviders, McpResource } from './resources';
import {
  frameworkResources,
  promptFromPath,
  RESOURCE_URIS,
  ResourceRegistry,
  toPrompts,
  URI_ARG_SCHEMA,
} from './resources';

describe('promptFromPath', () => {
  test('the name is the filename, version suffix included, extension stripped', () => {
    expect(promptFromPath('apps/web/app/posts/prompts/summarize.v3.md')).toEqual({
      name: 'summarize.v3',
      description: 'Versioned prompt artifact: apps/web/app/posts/prompts/summarize.v3.md',
    });
  });

  test('summarize.v2 and summarize.v3 are two different prompts', () => {
    const v2 = promptFromPath('prompts/summarize.v2.md');
    const v3 = promptFromPath('prompts/summarize.v3.md');
    expect(v2.name).not.toBe(v3.name);
  });

  test('a bare filename with no directory still works', () => {
    expect(promptFromPath('greet.txt').name).toBe('greet');
  });

  test('markdown, txt and prompt extensions are all recognised, case-insensitively', () => {
    expect(promptFromPath('a.MD').name).toBe('a');
    expect(promptFromPath('a.markdown').name).toBe('a');
    expect(promptFromPath('a.prompt').name).toBe('a');
  });

  test('an unrecognised extension is left in the name', () => {
    expect(promptFromPath('a.yaml').name).toBe('a.yaml');
  });
});

describe('toPrompts', () => {
  test('a string is authored into a prompt via promptFromPath', () => {
    expect(toPrompts(['prompts/greet.md'])).toEqual([promptFromPath('prompts/greet.md')]);
  });

  test('an object is already the wire shape and passes through unchanged', () => {
    const authored = { name: 'custom', description: 'hand-written' };
    expect(toPrompts([authored])).toEqual([authored]);
  });

  test('mixed input preserves order', () => {
    const authored = { name: 'custom', description: 'hand-written' };
    const result = toPrompts(['prompts/greet.md', authored]);
    expect(result).toEqual([promptFromPath('prompts/greet.md'), authored]);
  });
});

describe('frameworkResources', () => {
  test('an omitted provider is simply absent, never a placeholder entry', () => {
    expect(frameworkResources({})).toEqual([]);
    const manifestOnly = frameworkResources({ manifest: () => '{}' });
    expect(manifestOnly).toHaveLength(1);
    expect(manifestOnly[0]?.uri).toBe(RESOURCE_URIS.manifest);
  });

  test('every declared provider gets its documented uri and mimeType', async () => {
    const providers: FrameworkResourceProviders = {
      manifest: () => '{"m":1}',
      openapi: () => '{"o":1}',
      routes: () => '{"r":1}',
      schema: () => '{"s":1}',
    };
    const resources = frameworkResources(providers);
    expect(resources.map((r) => r.uri).sort()).toEqual(
      [
        RESOURCE_URIS.manifest,
        RESOURCE_URIS.openapi,
        RESOURCE_URIS.routes,
        RESOURCE_URIS.schema,
      ].sort(),
    );
    for (const r of resources) {
      expect(r.mimeType).toBe('application/json');
    }
  });

  test('read() is the provider thunk itself, invoked on demand', async () => {
    let calls = 0;
    const resources = frameworkResources({
      manifest: () => {
        calls += 1;
        return 'body';
      },
    });
    expect(calls).toBe(0);
    const manifest = resources.find((r) => r.uri === RESOURCE_URIS.manifest);
    expect(await manifest?.read()).toBe('body');
    expect(calls).toBe(1);
  });
});

describe('ResourceRegistry', () => {
  test('list is sorted by uri and is diffable between two boots', () => {
    const registry = new ResourceRegistry();
    registry.registerAll([
      { uri: 'ultimate://z', name: 'z', description: 'd', mimeType: 'text/plain', read: () => 'z' },
      { uri: 'ultimate://a', name: 'a', description: 'd', mimeType: 'text/plain', read: () => 'a' },
    ]);
    expect(registry.list().map((r) => r.uri)).toEqual(['ultimate://a', 'ultimate://z']);
  });

  test('list omits the body — read() is a separate call', () => {
    const registry = new ResourceRegistry();
    registry.register({
      uri: 'ultimate://one',
      name: 'one',
      description: 'd',
      mimeType: 'text/plain',
      read: () => 'body',
    });
    expect(registry.list()).toEqual([
      { uri: 'ultimate://one', name: 'one', description: 'd', mimeType: 'text/plain' },
    ]);
  });

  test('read resolves an async provider and stamps uri/mimeType onto the contents', async () => {
    const registry = new ResourceRegistry();
    registry.register({
      uri: 'ultimate://async',
      name: 'async',
      description: 'd',
      mimeType: 'application/json',
      read: async () => '{"ok":true}',
    });
    expect(await registry.read('ultimate://async')).toEqual({
      uri: 'ultimate://async',
      mimeType: 'application/json',
      text: '{"ok":true}',
    });
  });

  test('read of an unknown uri returns undefined, never throws', async () => {
    const registry = new ResourceRegistry();
    expect(await registry.read('ultimate://missing')).toBeUndefined();
  });

  test('registering the same uri twice is refused, as it is for a tool name', () => {
    // A URI is public API — AGENTS.md files quote them — so a second claim is not a choice the
    // registry may make by insertion order: whoever wired last would win and an agent would read
    // facts from a provider nobody picked. `ToolRegistry.register` already refuses for the same
    // reason; two registration paths in one package cannot answer this question two ways.
    const registry = new ResourceRegistry();
    const resource = (name: string): McpResource => ({
      uri: 'ultimate://manifest',
      name,
      description: 'd',
      mimeType: 'text/plain',
      read: () => name,
    });
    registry.register(resource('first'));

    let thrown: unknown;
    try {
      registry.register(resource('second'));
    } catch (error) {
      thrown = error;
    }

    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_MCP_RESOURCE_DUPLICATE');
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('ultimate://manifest');
    // The first registration stands: a refusal that half-applied would be its own surprise.
    expect(registry.list()).toEqual([
      { uri: 'ultimate://manifest', name: 'first', description: 'd', mimeType: 'text/plain' },
    ]);
  });

  test('registerAll refuses a duplicate inside one batch too', () => {
    const registry = new ResourceRegistry();
    const one = (name: string): McpResource => ({
      uri: 'ultimate://schema',
      name,
      description: 'd',
      mimeType: 'text/plain',
      read: () => name,
    });

    expect(() => registry.registerAll([one('a'), one('b')])).toThrow();
  });
});

describe('URI_ARG_SCHEMA', () => {
  test('declares one required uri string property with no extras', () => {
    expect(URI_ARG_SCHEMA.required).toEqual(['uri']);
    expect(URI_ARG_SCHEMA.additionalProperties).toBe(false);
    expect(URI_ARG_SCHEMA.properties?.['uri']?.type).toBe('string');
  });
});
