#!/usr/bin/env bash
# PostToolUse: every 5 minutes, record the WHOLE working tree (tracked edits and untracked files,
# .gitignore respected) as a commit under refs/snapshots/<epoch>, through a throwaway index — the
# real index, HEAD and the files are never touched. Recover: git checkout <ref> -- <path> by hand,
# after reading what it holds (git show --stat <ref>). Cleans up after itself: snapshots older than
# 3 days and past the newest 200 are deleted; `--prune` deletes every one (run it once a PR merged,
# when the work is safe in history), and git gc then drops their objects.
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ "$1" = "--prune" ]; then
  git for-each-ref --format='%(refname)' refs/snapshots | xargs -r -n1 git update-ref -d
  rm -f .git/snapshot-stamp
  echo "snapshots pruned"; exit 0
fi
stamp=.git/snapshot-stamp
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
  cutoff=$((now - 259200))
  git for-each-ref --format='%(refname)' refs/snapshots | while read -r ref; do
    [ "${ref##*/}" -lt "$cutoff" ] 2>/dev/null && git update-ref -d "$ref"
  done
) >/dev/null 2>&1 &
exit 0
