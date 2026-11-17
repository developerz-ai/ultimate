// `trimTrailingSlashes`: a string without its trailing `/` run, in one linear pass. `/\/+$/` is
// quadratic on a long run of slashes followed by anything else (CodeQL `js/polynomial-redos`), and
// a base URL, an issuer or an origin is often operator or caller input.

/** `value` with every trailing `/` removed; `'///'` becomes `''`. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
