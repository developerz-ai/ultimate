#!/usr/bin/env bash
# PreToolUse(Bash): refuse a command that discards uncommitted work. Hive work sits uncommitted
# for hours across many agents; one `git checkout -- .` lost ~200 files on 2026-11-07. The git
# rules are guard-git.ts; the recursive-delete rule is here. Exit 2 blocks and returns the reason.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
deny() {
  echo "BLOCKED by .claude/hooks/guard-destructive-git.sh: $1. Uncommitted work must never be discarded. Inspect with git status / git diff; to undo one file you edited, edit it back. Snapshots: git for-each-ref refs/snapshots" >&2
  exit 2
}
# guard-git.ts parses the command — quotes, comments, redirects, heredocs, `cd`, `git -C` and git's
# global options — because a regex over a flattened string both blocked and missed. A guard that
# cannot run fails closed for any command that mentions git.
here=$(dirname "$0")
if ! reason=$(printf '%s' "$input" | bun "$here/guard-git.ts" 2>&1); then
  case "$cmd" in *git*) deny "${reason:-guard-git.ts failed to run}" ;; esac
fi
flat=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')
# A recursive delete under the repo's source directories, unless every target is build output.
for target in $(printf '%s' "$flat" | grep -Eo 'rm -[a-zA-Z]*[rR][a-zA-Z]* +[^;&|]*' | sed -E 's/^rm -[a-zA-Z]+ +//'); do
  case "$target" in
    -*|*node_modules*|*/dist|*/dist/*|*/.x|*/.x/*|*.cache*|/tmp/*|*tsbuildinfo*) continue ;;
  esac
  case "$target" in
    packages*|examples*|dummy*|wiki*|docs*|scripts*|.git*|.claude*|*/ultimate|*/ultimate/|*/ultimate/packages*|*/ultimate/examples*|*/ultimate/dummy*|*/ultimate/wiki*|*/ultimate/docs*|*/ultimate/scripts*|.|./|\*|./\*) deny "rm -r of repo source ($target)" ;;
  esac
done
exit 0
