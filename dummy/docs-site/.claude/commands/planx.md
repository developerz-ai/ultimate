---
description: Write a short, self-contained plan for docs-site to docs/plans/, for another agent to execute.
argument-hint: [what you want done]
allowed-tools: Read, Glob, Grep, Bash, Write, Agent
---

# /planx

Plan only. No implementation, no edits outside the plan file.

## Goal
$ARGUMENTS

## Steps

1. **Read the code before planning against it.** If a claim in the ask is already false in the tree,
   say so under *Risks* with the `file:line` that disproves it, and plan what is actually true.
2. **Resolve the path.** The date comes from Bun in a named zone, never from the host's ambient one —
   `date +%F` gives a different answer on two machines at the same instant, and this app formats no
   date without an explicit IANA time zone.

   ```sh
   bun -e "console.log(new Intl.DateTimeFormat('en-CA', { timeZone: 'Etc/UTC' }).format(new Date()))"
   ```

   Then `docs/plans/<YYYY-MM-DD>-<slug>.md`. Slug is kebab-case, five words maximum. One file — a
   plan split across a directory is a plan nobody reads to the end.
3. **Write it.** Sections, in this order:

```markdown
# <Title>

## Goal
One or two sentences: what, and why.

## Primitive
Which of the eight (`entity · policy · action · mutator · query · job · route · task`) and which
slice it lives in. If it fits none, the design is wrong — say so here instead of planning a ninth.

## Files to change
- `path:line` — what changes, and why.

## Steps
1. Ordered, concrete. Name the `bunx x g` invocation where one applies. Point at code, do not paste it.

## Tests
- What to add, next to the source as `<file>.test.ts`. Command to run it.

## Done when
- Acceptance criteria, ending in `bun run verify` green.

## Risks
- Anything the executor must decide, and every claim in the ask the code disproves.
```

## Rules

- Fragments over sentences. `file:line` refs over prose. Tables for anything with three or more rows.
- Reference-only: point at the code, never re-explain it.
- No checkboxes. The plan is a map, not a tracker.
- The plan must obey the app's own rules — one way to do each thing, generators over hand-written
  files, imports that never cross a surface boundary, a stable error code with a runnable `fix:` for
  every new failure, and `bun run verify` green as the last line of *Done when*.

## Output

```
✓ docs/plans/<YYYY-MM-DD>-<slug>.md
Next: run it, or /feature it.
```
