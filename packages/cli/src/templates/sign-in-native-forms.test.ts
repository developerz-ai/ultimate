// D10: `x new --shape saas` (`x g sign-in --password`, `x g invite`) tripped its own `manifest` step
// six times with `X_NATIVE_FORM_UNANSWERED`. Every generated page's `<form method="post">` posts to
// an action whose generated declaration answers a browser natively — read with the step's own scan.

import { describe, expect, test } from 'bun:test';
import { postForms } from '../native-form-scan';
import { inviteFiles } from './invite';
import type { GeneratedFile } from './naming';
import { oidcSignInFiles } from './sign-in-oidc';
import { passwordSignInFiles } from './sign-in-password';

const textOf = (file: GeneratedFile): string =>
  typeof file.contents === 'string' ? file.contents : '';

/** Every action a generated page posts to, and the generated file that declares it. */
const formTargets = (files: readonly GeneratedFile[]) =>
  files
    .filter((file) => file.path.endsWith('/page.tsx'))
    .flatMap((page) => postForms(textOf(page)).map((form) => ({ page: page.path, form })))
    .map(({ page, form }) => {
      expect(form.target.kind).toBe('name');
      const name = form.target.value;
      const declared = files.find((file) =>
        textOf(file).includes(`export const ${name} = action({`),
      );
      return { page, name, source: declared === undefined ? '' : textOf(declared) };
    });

const generators: readonly (readonly [string, readonly GeneratedFile[], number])[] = [
  ['x g sign-in --password', passwordSignInFiles({ locales: ['en'] }), 3],
  ['x g sign-in --oidc', oidcSignInFiles('google', { locales: ['en'] }), 1],
  ['x g invite', inviteFiles({ locales: ['en'] }), 3],
];

describe('unit · every form a generator writes is answered natively', () => {
  for (const [label, files, forms] of generators) {
    test(`${label}: each posted action declares native`, () => {
      const targets = formTargets(files);
      // The count, so a scan that stopped reading forms cannot pass by finding none.
      expect(new Set(targets.map((target) => target.name)).size).toBe(forms);
      for (const { page, name, source } of targets) {
        expect({ page, name, declared: source !== '' }).toEqual({ page, name, declared: true });
        expect({ name, native: /\n {2}native: \{/.test(source) }).toEqual({ name, native: true });
      }
    });
  }
});
