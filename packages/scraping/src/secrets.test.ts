import { describe, expect, test } from 'bun:test';
import { secret } from '@ultimat3/core';
import { fakePage } from './driver-fake';
import {
  blankPasswordFields,
  createSecretBag,
  MIN_REDACTABLE_LENGTH,
  redactSecrets,
  SECRET_PLACEHOLDER,
  safeHtml,
} from './secrets';

const bag = (values: Record<string, string>) =>
  createSecretBag(Object.keys(values), (name) => values[name]);

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · secrets are names in the definition and values in the worker', () => {
  test('a declared name with no value refuses the run, naming the file to edit', () => {
    let thrown: { code?: string; fix?: string } = {};
    try {
      createSecretBag(['BANK_PASSWORD'], () => undefined);
    } catch (error) {
      thrown = error as { code?: string; fix?: string };
    }
    expect(thrown.code).toBe('X_ENV_MISSING');
    expect(thrown.fix).toContain('.env.local');
  });

  test('an undeclared name cannot be read — a run resolves only what it declared', () => {
    const secrets = bag({ A: 'one' });
    expect(() => secrets.get('B')).toThrow();
  });

  test('the value is boxed, so printing it renders [redacted]', () => {
    const secrets = bag({ BANK_PASSWORD: 'hunter2' });
    expect(`${String(secrets.get('BANK_PASSWORD'))}`).toBe('[redacted]');
    expect(JSON.stringify({ p: secrets.get('BANK_PASSWORD') })).toBe('{"p":"[redacted]"}');
  });
});

describe('unit · redaction is BY VALUE, not by key name', () => {
  test('a secret in a query string is redacted even though it travels under no known key', () => {
    const secrets = bag({ TOKEN: 'sk-live-abcdef' });
    expect(redactSecrets('GET /orders?key=sk-live-abcdef', secrets)).toBe(
      'GET /orders?key=[redacted]',
    );
  });

  /**
   * The floor was a bare `.length >= 4` with no comment, under a header promising unconditional
   * redaction. It is deliberate — a three-character PIN is a substring of ordinary prose, so
   * redacting one blanks every price, id and timestamp fragment on the page and the artifact
   * becomes undiagnosable — but a hole nobody wrote down is a hole nobody can reason about.
   */
  test('a secret shorter than the floor is NOT redacted, and that is the documented answer', () => {
    const short = 'x'.repeat(MIN_REDACTABLE_LENGTH - 1);
    expect(redactSecrets(`pin ${short}`, bag({ PIN: short }))).toBe(`pin ${short}`);
  });

  test('a secret AT the floor is redacted — the bound is >=, not >', () => {
    const exact = 'x'.repeat(MIN_REDACTABLE_LENGTH);
    expect(redactSecrets(`pin ${exact}`, bag({ PIN: exact }))).toBe(`pin ${SECRET_PLACEHOLDER}`);
  });

  test('the longest secret goes first, so one containing another leaves no tail', () => {
    const secrets = bag({ SHORT: 'abcd', LONG: 'abcd-efgh' });
    expect(redactSecrets('abcd-efgh', secrets)).toBe('[redacted]');
  });

  test('a password field is blanked structurally, whatever the value was', () => {
    expect(blankPasswordFields('<input type="password" value="hunter2" name="p">')).toBe(
      '<input type="password" value="" name="p">',
    );
  });

  test("attribute ORDER is the site's choice — value before type is blanked too", () => {
    // The whole finding: `saveFailureArtifact` writes `page.html()` to object storage on every
    // failed run, so a server-rendered password on a reversed-attribute form was durably kept.
    expect(blankPasswordFields('<input value="hunter2" type="password">')).toBe(
      '<input value="" type="password">',
    );
    expect(blankPasswordFields('<input name="p" value="hunter2" type=password >')).toBe(
      '<input name="p" value="" type=password >',
    );
    expect(blankPasswordFields("<input value='hunter2' type='password'>")).toBe(
      '<input value="" type=\'password\'>',
    );
  });

  test('a non-password input keeps its value — the blank is structural, not a sweep', () => {
    expect(
      blankPasswordFields('<input value="ada" type="text"><input value="x" name="passwordish">'),
    ).toBe('<input value="ada" type="text"><input value="x" name="passwordish">');
  });

  test('safeHtml does both passes', () => {
    const secrets = bag({ P: 'hunter2' });
    expect(safeHtml('<input type=password value=hunter2><b>hunter2</b>', secrets)).toBe(
      '<input type=password value=""><b>[redacted]</b>',
    );
  });
});

describe('unit · a screenshot of a filled login form is a live leak', () => {
  const LOGIN = '<form><input id="p" type="password"><button id="go">Go</button></form>';

  test('a pixel capture is REFUSED once a secret has been typed into the page', async () => {
    const page = fakePage(LOGIN);
    // Before: fine. The refusal is about what is on the page, not about the page.
    expect((await page.screenshot()).byteLength).toBeGreaterThan(0);
    await page.type('#p', secret('hunter2', 'BANK_PASSWORD'));
    expect(await codeOf(page.screenshot())).toBe('X_SCRAPE_SECRET_EXPOSED');
    expect(await codeOf(page.pdf())).toBe('X_SCRAPE_SECRET_EXPOSED');
  });

  test('a plain string does not taint the page — only a Secret does', async () => {
    const page = fakePage(LOGIN);
    await page.type('#p', 'not-a-secret');
    expect((await page.screenshot()).byteLength).toBeGreaterThan(0);
  });

  test('page.html() stays available, redacted — the artifact you actually want on a failure', async () => {
    const secrets = bag({ BANK_PASSWORD: 'hunter2' });
    const page = fakePage(LOGIN, { context: { secrets } });
    await page.type('#p', secrets.get('BANK_PASSWORD'));
    const html = await page.html();
    expect(html).not.toContain('hunter2');
  });
});
