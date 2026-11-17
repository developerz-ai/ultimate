// What the `agent` shape promises, read off its planned files: the model named by the environment
// alone, a tool and the agent on the MCP surface, the run queued as a job, and an eval baseline
// recorded against the prompt it writes.

import { describe, expect, test } from 'bun:test';
import { promptHash } from '@ultimat3/ai';
import { planNewApp } from '../../cmd-new';
import type { GeneratedFile } from '../naming';
import { MODEL_ENV_SCHEMA } from './agent-model';
import { SUGGEST_TITLE_PROMPT } from './agent-prompt';

const files = planNewApp({ name: 'probe', example: true, shape: 'agent' });
const base = planNewApp({ name: 'probe', example: true });

const textAt = (plan: readonly GeneratedFile[], path: string): string => {
  const file = plan.find((candidate) => candidate.path === path);
  return typeof file?.contents === 'string' ? file.contents : '';
};

const DIR = 'apps/web/app/assistant';

describe('unit · x new --shape agent', () => {
  test('nothing of the default left out, and the assistant slice added', () => {
    const paths = files.map((file) => file.path);
    expect(base.map((file) => file.path).filter((path) => !paths.includes(path))).toEqual([]);
    for (const path of [
      `${DIR}/model.ts`,
      `${DIR}/actions/suggest-title.ts`,
      `${DIR}/actions/post-titles.ts`,
      `${DIR}/jobs/draft-post-later.ts`,
      `${DIR}/prompts/suggest-title.evals.ts`,
    ]) {
      expect({ path, written: paths.includes(path) }).toEqual({ path, written: true });
    }
  });

  test('the model is the environment’s: declared in app.config.ts and .env.example, spelled nowhere', () => {
    const config = textAt(files, 'app.config.ts');
    const example = textAt(files, '.env.example');
    for (const key of Object.keys(MODEL_ENV_SCHEMA)) {
      expect({ key, config: config.includes(`  ${key}: {`) }).toEqual({ key, config: true });
      expect({ key, example: example.includes(`\n${key}=\n`) }).toEqual({ key, example: true });
    }
    // No prompt or agent names a model: the gateway's `defaultModel` (LLM_MODEL) answers.
    for (const file of files.filter((one) => one.path.startsWith(DIR))) {
      const text = typeof file.contents === 'string' ? file.contents : '';
      expect({ path: file.path, model: /^\s+model: /m.test(text) }).toEqual({
        path: file.path,
        model: false,
      });
    }
    expect(textAt(files, 'apps/web/runtime.ts')).toContain('...modelRuntime(Bun.env),');
  });

  test('the agent calls a real action as its tool, and both are MCP tools', () => {
    const agent = textAt(files, `${DIR}/actions/suggest-title.ts`);
    expect(agent).toContain('tools: [postTitles],');
    expect(agent).toContain('expose: true');
    expect(textAt(files, `${DIR}/actions/post-titles.ts`)).toContain('expose: true');
    const api = textAt(files, 'apps/web/api/index.ts');
    expect(api).toContain('postTitles, suggestTitle, draftPost, queueDraft],');
    expect(api).toContain('jobs: [reindexPost, draftPostLater],');
  });

  test('the long run is an agentJob acting as a role the app declares', () => {
    expect(textAt(files, `${DIR}/jobs/draft-post-later.ts`)).toContain('agentJob(draftPost, {');
    expect(textAt(files, 'apps/web/shared/roles.ts')).toContain('  assistant: {');
    expect(textAt(files, 'package.json')).toContain('"@ultimat3/ai": "^');
  });

  test('the eval baseline is recorded against the prompt the shape writes', () => {
    const baseline: unknown = JSON.parse(
      textAt(files, `${DIR}/prompts/suggest-title.v1.baseline.json`),
    );
    expect(baseline).toMatchObject({ promptHash: promptHash(SUGGEST_TITLE_PROMPT), score: 1 });
    const prompt = textAt(files, `${DIR}/prompts/suggest-title.ts`);
    // The rendered template is the declaration's, escaped once: what is hashed is what is written.
    expect(prompt).toContain('Call \\`postTitles\\` once, first');
    expect(prompt).toContain(`id: '${SUGGEST_TITLE_PROMPT.id}',`);
  });
});
