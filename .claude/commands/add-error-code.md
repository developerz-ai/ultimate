---
description: Add a new X_* error code with its fix command and docs entry
argument-hint: <PACKAGE> <X_CODE> <what went wrong>
---

Add error code `$2` to `packages/$1/src/errors.ts`.

Requirements — all four, or don't add it:

1. A subclass of `UltimateError` with the code, a `cause` naming the actual identifier at fault, and a `fix:` that is an **executable command** where one exists.
2. Registered in the package's code registry so the CLI and dev overlay render it identically.
3. A row in `wiki/Error-Codes.md`: code, meaning, cause, fix.
4. A test asserting the rendered terminal output and the `--json` shape.

A shipped code is stable forever — agents pattern-match on it. Pick the name carefully.
