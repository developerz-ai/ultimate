// The interfaces an app only ever CONSUMES — the framework builds every value of the type, and the
// app's extension seam is another, implementable one — so a REQUIRED member added breaks no code
// (`public-api-compat-rules.ts`' `members`). A row is a reviewed claim with its why; a member
// removed, retyped or made required is still a break on a listed interface.

/** `<specifier>#<name>` → why no app implements it, and what it implements instead. */
export const CONSUMED_ONLY: Readonly<Record<string, string>> = Object.freeze({
  '@ultimat3/entity#Table':
    "why: every Table is entity's tableFor over a Repo (query.ts), reached as database()'s or db's handle; an app's store implements the Repo port (defineDriver), whose new members stay optional (repo.ts), never Table",
});

export const isConsumedOnly = (specifier: string, name: string): boolean =>
  Object.hasOwn(CONSUMED_ONLY, `${specifier}#${name}`);
