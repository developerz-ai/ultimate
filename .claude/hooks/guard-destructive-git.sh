#!/usr/bin/env bash
# PreToolUse(Bash): refuse a command that discards uncommitted work. Hive work sits uncommitted
# for hours across many agents and the disk keeps no snapshots; one `git checkout -- .` lost ~200
# files on 2026-11-07. Exit 2 blocks the call and hands the reason back to the agent.
cmd=$(jq -r '.tool_input.command // ""')
deny() {
  echo "BLOCKED by .claude/hooks/guard-destructive-git.sh: $1. Uncommitted work must never be discarded. Inspect with git status / git diff; to undo one file you edited, edit it back. Snapshots: git for-each-ref refs/snapshots" >&2
  exit 2
}
# Normalise whitespace so `git  checkout` and newlines cannot slip past.
flat=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')
case "$flat" in
  *"git checkout -- "*|*"git checkout -q -- "*|*"git checkout -f"*|*"git checkout ."*|*"git checkout -q ."*) deny "git checkout over working-tree paths" ;;
esac
printf '%s' "$flat" | grep -Eq '(^|[;&| ])git (-C [^ ]+ )?restore( |$)' && ! printf '%s' "$flat" | grep -Eq 'git restore --staged' && deny "git restore"
printf '%s' "$flat" | grep -Eq '(^|[;&| ])git (-C [^ ]+ )?reset( [^;&|]*)? --(hard|merge|keep)' && deny "git reset --hard/--merge/--keep"
printf '%s' "$flat" | grep -Eq '(^|[;&| ])git (-C [^ ]+ )?clean( |$)' && deny "git clean"
printf '%s' "$flat" | grep -Eq '(^|[;&| ])git (-C [^ ]+ )?stash( |$)' && deny "git stash (forbidden in this repo)"
printf '%s' "$flat" | grep -Eq '(^|[;&| ])git (-C [^ ]+ )?(switch|checkout) [^;&|]*( -f| --force| --discard-changes)( |$|[;&|])' && deny "a forced branch switch"
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
