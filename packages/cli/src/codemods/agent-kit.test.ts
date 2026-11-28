// The codemod that hands `.claude/commands` and `.claude/agents` to the kit: an unedited released
// form is deleted, an edited one is kept as the app's own `app-<name>.md`, and nothing is lost.

import { describe, expect, test } from 'bun:test';
import { kitFormHash } from '../app-kit-forms';
import { kitFiles } from '../kit/registry';
import { RELEASED_KIT_FORMS } from '../templates/kit-released-forms';
import { names } from '../templates/naming';
import { agentKitCodemod, codemod } from './agent-kit';
import { memoryCodemodApp } from './codemod';

const OLD_COMMAND = 'old feature command for blog\n';
const OLD_AGENT = '---\nname: shape\ntools: Read, mcp__blog__*\n---\nYou decide in blog.\n';
const forms = {
  '.claude/commands/feature.md': [kitFormHash(OLD_COMMAND, 'blog')],
  '.claude/agents/shape.md': [kitFormHash(OLD_AGENT, 'blog')],
};
const app = (files: Record<string, string>) =>
  memoryCodemodApp({ 'package.json': '{"name":"blog"}\n', ...files });

describe('unit · agent-kit codemod', () => {
  test('an unedited released command and agent are deleted', async () => {
    const target = app({
      '.claude/commands/feature.md': OLD_COMMAND,
      '.claude/agents/shape.md': OLD_AGENT,
    });
    const result = await agentKitCodemod(forms).run(target);
    expect([...result.changed].sort()).toEqual([
      '.claude/agents/shape.md',
      '.claude/commands/feature.md',
    ]);
    expect(result.skipped).toEqual([]);
    expect(Object.keys(target.files)).toEqual(['package.json']);
  });

  test('a released form under another app name is still unedited', async () => {
    const target = app({ '.claude/commands/feature.md': OLD_COMMAND.replaceAll('blog', 'shop') });
    await agentKitCodemod({
      '.claude/commands/feature.md': [kitFormHash(OLD_COMMAND.replaceAll('blog', 'shop'), 'shop')],
    }).run({
      ...target,
      read: async (p) => (p === 'package.json' ? '{"name":"shop"}' : target.files[p]),
    });
    expect(target.files['.claude/commands/feature.md']).toBeUndefined();
  });

  test('an edited command becomes app-feature.md, reported with the diff to the managed skill', async () => {
    const edited = `${OLD_COMMAND}my own step\n`;
    const target = app({ '.claude/commands/feature.md': edited });
    const result = await agentKitCodemod(forms).run(target);
    expect(target.files['.claude/commands/feature.md']).toBeUndefined();
    expect(target.files['.claude/commands/app-feature.md']).toBe(edited);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe('.claude/commands/app-feature.md');
    expect(result.skipped[0]?.reason).toContain('.claude/skills/feature/SKILL.md');
    expect(result.skipped[0]?.diff).toContain('my own step');
  });

  test('an edited agent is renamed, and its front matter stops claiming the managed name', async () => {
    const edited = OLD_AGENT.replace('You decide', 'I decide');
    const target = app({ '.claude/agents/shape.md': edited });
    await agentKitCodemod(forms).run(target);
    expect(target.files['.claude/agents/shape.md']).toBeUndefined();
    const kept = target.files['.claude/agents/app-shape.md'] ?? '';
    expect(kept).toContain('name: app-shape\n');
    expect(kept).toContain('I decide in blog.');
  });

  test('an app-<name>.md already there is never overwritten', async () => {
    const target = app({
      '.claude/commands/feature.md': `${OLD_COMMAND}edit\n`,
      '.claude/commands/app-feature.md': 'mine\n',
    });
    await agentKitCodemod(forms).run(target);
    expect(target.files['.claude/commands/app-feature.md']).toBe('mine\n');
    expect(target.files['.claude/commands/app-feature-2.md']).toContain('edit');
  });

  test('an agent already as the kit renders it is left alone', async () => {
    const current = kitFiles(names('blog')).find((f) => f.path === '.claude/agents/web.md');
    const target = app({ '.claude/agents/web.md': current?.contents ?? '' });
    expect(await agentKitCodemod(forms).run(target)).toEqual({ changed: [], skipped: [] });
    expect(Object.keys(target.files).sort()).toEqual(['.claude/agents/web.md', 'package.json']);
  });

  test("an app with the kit marker is the kit's to judge, not the codemod's", async () => {
    const target = app({ '.claude/kit.json': '{"off":[]}', '.claude/agents/shape.md': 'edited\n' });
    expect(await agentKitCodemod(forms).run(target)).toEqual({ changed: [], skipped: [] });
  });

  test('a second run changes nothing', async () => {
    const target = app({ '.claude/commands/feature.md': `${OLD_COMMAND}edit\n` });
    await agentKitCodemod(forms).run(target);
    const again = await agentKitCodemod(forms).run(target);
    expect(again).toEqual({ changed: [], skipped: [] });
  });

  test('the committed table names every file the kit replaces', () => {
    for (const path of [
      '.claude/commands/feature.md',
      '.claude/commands/planx.md',
      '.claude/commands/verify.md',
      '.claude/agents/shape.md',
      '.claude/agents/data.md',
      '.claude/agents/server.md',
      '.claude/agents/web.md',
    ]) {
      expect(RELEASED_KIT_FORMS[path]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(codemod.id).toBe('agent-kit');
  });
});
