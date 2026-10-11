// What `x verify` says about the query an `isr` route keys on. Advice and not a finding: the scan
// reads source text, so it can miss a read made through a helper and can name one that is not a
// query read at all — and a route that declared nothing works as it always did. Both are exactly
// what a reader should hear about before a visitor finds it.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { stripComments } from '@ultimat3/core';
import { describePages } from '@ultimat3/render';
import { msg } from './messages';

const MEMBER_READ = /\bquery\s*\??\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g;
const BRACKET_READ = /\bquery\s*(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\]/g;
const SEARCH_PARAM_READ = /\bsearchParams\s*\??\.\s*(?:get|getAll|has)\(\s*['"]([^'"]+)['"]/g;

/**
 * The query parameter names a route module reads, as far as its text says: `query.name`,
 * `query?.name`, `query['name']` and `searchParams.get('name')` (also `getAll`, `has`). A call
 * (`query.where(…)`) is a method, not a parameter. Sorted, each once.
 */
export function queryReads(source: string): readonly string[] {
  const code = stripComments(source);
  const names = new Set<string>();
  for (const pattern of [MEMBER_READ, BRACKET_READ, SEARCH_PARAM_READ]) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].sort();
}

const listed = (names: readonly string[]): string => names.map((name) => `'${name}'`).join(', ');

/**
 * One line per `isr` route with no `revalidate.query` — it renders and stores a page for every
 * distinct query string, so `?x=1`, `?x=2`, … evict its real pages and cost a render each — and
 * one per parameter a route's module reads and its declaration omits: the page is stored under a
 * key without it, so every visitor gets the document rendered for whichever value arrived first.
 */
export async function isrQueryAdvice(root: string): Promise<readonly string[]> {
  const advice: string[] = [];
  for (const route of describePages()) {
    if (route.mode !== 'isr') continue;
    const declared = route.revalidateQuery ?? null;
    if (declared === null) {
      advice.push(msg('cli.verify.isrQueryUndeclared', { file: route.file }));
      continue;
    }
    const module = Bun.file(join(root, route.file));
    if (!(await module.exists())) continue;
    for (const name of queryReads(await module.text())) {
      if (declared.includes(name)) continue;
      advice.push(
        msg('cli.verify.isrQueryOmitted', {
          file: route.file,
          name,
          declared: listed([...declared, name].sort()),
        }),
      );
    }
  }
  return advice;
}
