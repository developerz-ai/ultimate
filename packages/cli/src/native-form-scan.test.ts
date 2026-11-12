// The four spellings a page uses to name a form's action, each read; and the forms it must skip.

import { describe, expect, test } from 'bun:test';
import { pathMatches, postForms } from './native-form-scan';

describe('postForms', () => {
  test('a literal path', () => {
    const page = `<main>\n  <form class={styles.card} method="post" action="/api/sessions/create">`;
    expect(postForms(page)).toEqual([
      { line: 2, target: { kind: 'path', value: '/api/sessions/create' } },
    ]);
  });

  test('derivePath through two same-file consts, `satisfies` and all', () => {
    const page = [
      "const CREATE_ACTION = 'createPost' satisfies keyof Api['actions'];",
      'const CREATE_ENDPOINT = derivePath(CREATE_ACTION).path;',
      '<form class={styles.form} method="post" action={CREATE_ENDPOINT}>',
    ].join('\n');
    expect(postForms(page)).toEqual([{ line: 3, target: { kind: 'name', value: 'createPost' } }]);
  });

  test('actionHttpPath inline, its params object and a `>` inside braces skipped', () => {
    const page = [
      "const PUBLISH_ACTION = 'publishPost';",
      '<form',
      '  method="post"',
      '  data-x={a > b ? 1 : 2}',
      '  action={actionHttpPath(PUBLISH_ACTION, { postId: props.data.id }).path}',
      '>',
    ].join('\n');
    expect(postForms(page)).toEqual([{ line: 2, target: { kind: 'name', value: 'publishPost' } }]);
  });

  test("derivePath on an inline literal: `derivePath('withdrawPost' satisfies …)`", () => {
    const page = `<form method="post" action={derivePath('withdrawPost' satisfies keyof Api['actions']).path}>`;
    expect(postForms(page)[0]?.target).toEqual({ kind: 'name', value: 'withdrawPost' });
  });

  test.each([
    ['a GET form', '<form method="get" action="/search">'],
    ['no method (a GET)', '<form action="/api/posts/create">'],
    ['no action', '<form method="post">'],
    ['an expression it cannot read', '<form method="post" action={endpointFor(kind)}>'],
    ['an absolute URL on another site', '<form method="post" action="https://pay.test/x">'],
  ])('%s is not read', (_label, page) => {
    expect(postForms(page)).toEqual([]);
  });
});

describe('pathMatches', () => {
  test('a static route, and a `:param` segment against any one segment', () => {
    expect(pathMatches('/api/posts/create', '/api/posts/create')).toBe(true);
    expect(pathMatches('/orders/:id/refund', '/orders/42/refund?x=1')).toBe(true);
    expect(pathMatches('/orders/:id/refund', '/orders/42/cancel')).toBe(false);
    expect(pathMatches('/api/posts/create', '/api/posts/create/extra')).toBe(false);
  });
});
