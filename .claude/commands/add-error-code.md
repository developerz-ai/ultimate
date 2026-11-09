---
description: Add a new X_* error code — registration, wiki row and HTTP status in one command
argument-hint: <PACKAGE> <X_CODE> <what went wrong>
---

Add error code `$2` to `@ultimat3/$1`. One command writes every shared file, together or not at all:

```sh
bun run new-error-code $2 --package $1 --title '…' --cause '…' --fix '…' (--status <n> | --off-socket) --dry-run
```

Read the dry run, then drop `--dry-run`. It writes the registration in `packages/$1/src/errors.ts`,
the `wiki/Error-Codes.md` row, and the HTTP decision: `--status <n>` → a row in
`packages/http/src/error-map.ts`, `--off-socket` → a pin in `scripts/error-map-backlog.ts`. Tier ≤ 4
takes exactly one of the two; tier 5 neither.

Still yours:

1. The throw site — the class or factory that raises it. `cause` names the actual identifier at
   fault; `fix` is an **executable** command, a call to paste, or an edit naming a file.
2. A test asserting the rendered terminal output and the `--json` shape.

The command edits shared files: in a hive only the coordinator (or the one agent the brief names)
runs it. A shipped code is stable forever — agents pattern-match on it. Pick the name carefully.
