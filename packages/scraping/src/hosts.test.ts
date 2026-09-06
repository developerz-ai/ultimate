import { describe, expect, test } from 'bun:test';
import { ANY_HOST, hostDecision, hostMatches } from './hosts';

describe('unit · allowHosts matching', () => {
  test('an exact rule matches that host and NOT its subdomains', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    // The half that matters: a rule written for the apex must not admit a subdomain whose
    // contents somebody else controls.
    expect(hostMatches('cdn-user-content.example.com', 'example.com')).toBe(false);
  });

  test('a wildcard rule matches subdomains and NOT the apex', () => {
    expect(hostMatches('api.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
  });

  test('case and surrounding space do not decide access', () => {
    expect(hostMatches('EXAMPLE.com', ' Example.COM ')).toBe(true);
  });

  test(`${ANY_HOST} matches everything, and is the only spelling that does`, () => {
    expect(hostMatches('anything.test', ANY_HOST)).toBe(true);
  });
});

describe('unit · the decision fails CLOSED', () => {
  test('a URL that cannot be parsed is refused', () => {
    // "We could not tell where it was going, so we let it through" is what makes an allow list
    // advisory. The SSRF case is exactly the malformed one.
    expect(hostDecision('http://[not a url', ['example.com'])).toEqual({
      allowed: false,
      host: '',
    });
  });

  test('an unlisted host is refused and the decision names it', () => {
    expect(hostDecision('http://169.254.169.254/latest/meta-data/', ['example.com'])).toEqual({
      allowed: false,
      host: '169.254.169.254',
    });
  });

  test('a hostless scheme is allowed — every run starts on about:blank', () => {
    expect(hostDecision('about:blank', []).allowed).toBe(true);
    expect(hostDecision('data:text/html,<p>x', []).allowed).toBe(true);
  });

  test('an empty allow list admits nothing', () => {
    expect(hostDecision('https://example.com/', []).allowed).toBe(false);
  });

  test('javascript: is REFUSED, on every allow list including the wildcard one', () => {
    // It sat on the same line as about:/data:/blob: because it has no host either — but "no host"
    // is where the resemblance ends: the other three are inert content, and this one executes in
    // the page's origin with the session's cookies. An allow list cannot say anything about it,
    // so the fail-closed answer is the only honest one.
    expect(hostDecision('javascript:fetch("/admin").then(r=>r.text())', [ANY_HOST])).toEqual({
      allowed: false,
      host: '',
    });
    expect(hostDecision('JavaScript:alert(1)', ['example.com']).allowed).toBe(false);
  });

  test('javascript://<an allow-listed host>/%0a<code> is refused too — the authority is a comment', () => {
    // Deleting `javascript:` from the hostless set is not the fix on its own: `javascript:` is not
    // a special scheme, so `//api.test` really does parse as an authority, `hostMatches` really
    // does match it, and the payload after the newline runs in the CURRENT page's origin. The
    // scheme is refused by name for this shape, not by having no host.
    expect(hostDecision('javascript://api.test/%0afetch("/admin")', ['api.test'])).toEqual({
      allowed: false,
      host: '',
    });
  });
});
