#!/usr/bin/env bash
# PostToolUse: every 5 minutes, when TRACKED files differ from HEAD, record the whole working tree
# (untracked files too, .gitignore respected) as a commit under refs/snapshots/<epoch>, through a
# throwaway index — the real index, HEAD and the files are never touched. A read-only agent never
# writes a ref: "read-only means no git writes" (.claude/agents/bug-hunter.md). Recover: git
# checkout <ref> -- <path> by hand, after git show --stat <ref>. Snapshots older than 7 days and past
# the newest 200 are deleted; `--prune` deletes every one (run it once a PR merged).
input=$( [ -t 0 ] || cat )
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ "$1" = "--prune" ]; then
  git for-each-ref --format='%(refname)' refs/snapshots | xargs -r -n1 git update-ref -d
  rm -f "$(git rev-parse --git-dir)/snapshot-stamp"
  echo "snapshots pruned"; exit 0
fi
# The harness names the subagent a tool call came from. Read-only = its tools list neither Edit
# nor Write (an agent file here), or a built-in read-only type. The main session has no agent_type.
agent=$(printf '%s' "$input" | jq -r '.agent_type // ""' 2>/dev/null)
if [ -n "$agent" ]; then
  case "$agent" in Explore|Plan|claude-code-guide|statusline-setup) exit 0 ;; esac
  file=".claude/agents/$agent.md"
  if [ -f "$file" ]; then
    tools=$(sed -n '2,/^---$/{/^tools:/p}' "$file")
    case "$tools" in *Edit*|*Write*) ;; *) exit 0 ;; esac
  fi
fi
# Nothing tracked moved: nothing a revert could lose that HEAD does not already hold.
git diff --quiet HEAD -- 2>/dev/null && exit 0
stamp="$(git rev-parse --git-dir)/snapshot-stamp"
now=$(date +%s)
[ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt 300 ] && exit 0
echo "$now" > "$stamp"
(
  tmp=$(mktemp)
  export GIT_INDEX_FILE="$tmp"
  git read-tree HEAD && git add -A . >/dev/null 2>&1 || { rm -f "$tmp"; exit 0; }
  tree=$(git write-tree) || { rm -f "$tmp"; exit 0; }
  rm -f "$tmp"
  unset GIT_INDEX_FILE
  [ "$tree" = "$(git rev-parse HEAD^{tree})" ] && exit 0
  commit=$(git commit-tree "$tree" -p HEAD -m "snapshot $(date -u +%FT%TZ) of $(git rev-parse --abbrev-ref HEAD)") || exit 0
  git update-ref "refs/snapshots/$now" "$commit"
  git for-each-ref --sort=-refname --format='%(refname)' refs/snapshots | tail -n +201 | xargs -r -n1 git update-ref -d
  cutoff=$((now - 604800))
  git for-each-ref --format='%(refname)' refs/snapshots | while read -r ref; do
    [ "${ref##*/}" -lt "$cutoff" ] 2>/dev/null && git update-ref -d "$ref"
  done
) >/dev/null 2>&1 &
exit 0
