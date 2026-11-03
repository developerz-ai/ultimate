# Sourced, never run: `x new proofapp` on THIS tree's packages, shared by run.sh (the chart) and
# compose.sh (Compose). Every @ultimat3/* package is packed into the app's vendor/ and pinned as an
# override, so the image installs this tree and not what npm serves. Needs `refuse` from the caller.
#
#   scaffold_proof_app "$REPO" "$WORK"     # writes and installs "$WORK/proofapp"

scaffold_proof_app() {
  local repo="$1" work="$2" app="$2/proofapp" dir name
  (cd "$repo" && bun run x -- new proofapp --dir "$work" --json >/dev/null)
  mkdir -p "$app/vendor"
  for dir in "$repo"/packages/*/; do
    name="$(jq -r '.name // ""' "$dir/package.json")"
    # A nameless workspace would fall through the case below and ship the npm copy instead of this tree's.
    [ -n "$name" ] || refuse "$dir/package.json has no name, so it cannot be packed into the proof app. fix: give it its @ultimat3/<pkg> name"
    case "$name" in @ultimat3/*) (cd "$dir" && bun pm pack --destination "$app/vendor" --quiet >/dev/null) ;; esac
  done
  (cd "$app" && bun -e '
    const pkg = await Bun.file("package.json").json();
    pkg.overrides = {};
    for (const file of new Bun.Glob("vendor/ultimat3-*.tgz").scanSync(".")) {
      const name = file.slice("vendor/ultimat3-".length).replace(/-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/, "");
      pkg.overrides[`@ultimat3/${name}`] = `file:./${file}`;
    }
    await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  ' && bun install >/dev/null)
}
