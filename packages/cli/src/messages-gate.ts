// The gate's rows of the CLI catalog (`messages.ts` composes them): `x verify`, `x ci`, `x pr`
// and `x affected`. Data only — `msg()` is the one lookup.

export const GATE_MESSAGES = {
  'cli.affected.count':
    '{count} workspace(s) affected by {base}...HEAD, from {changed} changed file(s)',
  'cli.affected.dirty':
    '  including the working tree (--dirty): every uncommitted change in this checkout, whoever made it',
  'cli.affected.none': 'no workspace is affected by {base}...HEAD, from {changed} changed file(s)',
  'cli.affected.rootWide':
    '  every workspace: {files} belongs to none of them and changes what all of them compile',
  'cli.ci.failed':
    '{failed} of {runs} workflow run(s) on {branch} failed — {findings} finding(s) recovered from the log',
  'cli.ci.green': 'every one of {runs} workflow run(s) on {branch} passed',
  'cli.ci.job': '  {conclusion}  {job}  ({steps})',
  'cli.ci.jobs.other': '  {count} other job(s) in this run',
  'cli.ci.logs.empty': '  the failed step wrote no log — {url}',
  /** The conclusion of a run GitHub has not finished — a value, not a column key. */
  'cli.ci.pending': 'pending',
  'cli.ci.run': '{conclusion}  {workflow}  {url}',
  'cli.ci.running':
    '{running} of {runs} workflow run(s) on {branch} has not finished — nothing has failed yet',
  'cli.ci.tail': '  log tail, {job}:',
  // `x ci tested`, one reason per condition (`TESTED_CONDITIONS`): what reused, or why it ran all.
  'cli.ci.tested.tested':
    'tested: PR #{pr} merged this tree, and {workflow} run {run} passed on its head — the jobs it ran are reused',
  'cli.ci.tested.subject':
    'not tested: the subject does not end (#N), so no pull request merged this commit — a full run',
  'cli.ci.tested.merged': 'not tested: PR #{pr} was not merged as this commit — a full run',
  'cli.ci.tested.fork':
    "not tested: PR #{pr}'s head is not in {repo}, and a fork's run is never reused — a full run",
  'cli.ci.tested.tree':
    "not tested: this tree is not PR #{pr}'s head tree, so its base moved after the run — a full run",
  'cli.ci.tested.run': "not tested: no green {workflow} run on PR #{pr}'s head — a full run",
  'cli.ci.tested.stale':
    'not tested: {workflow} run {run} for PR #{pr} is older than {maxAge} — a full run',
  'cli.ci.tested.api': 'not tested: GitHub did not answer ({detail}) — a full run',
  'cli.ci.tested.sha':
    'not tested: no GITHUB_SHA, and git rev-parse HEAD named no commit — a full run',
  // A review bot that said it did NOT review leaves no thread, so its silence reads as a clean
  // review unless a line says otherwise. `notice` is the same fact once the bot reviewed after it.
  'cli.pr.bot.blocked': '  {login} did not review: {excerpt} ({kind}, {at}) — {url}',
  'cli.pr.bot.notice': '  {login} posted a {kind} notice at {at}, then reviewed at {reviewed}',
  'cli.pr.body.truncated': '      … {hidden} more line(s) — re-run with --full',
  /** The line of a thread whose anchor GitHub answers null for — a value, not a column key. */
  'cli.pr.line.unknown': '-',
  'cli.pr.replied': 'replied on thread {id}: {url}',
  // Resolving closes a CONVERSATION. Whether the finding is fixed is a fact about the code that
  // no GitHub mutation observes, and a summary saying "addressed" would assert one from the other.
  'cli.pr.resolved':
    'thread {id} is marked resolved on GitHub — that records the conversation, not that the finding is fixed',
  'cli.pr.review.count':
    '{unresolved} unresolved and {resolved} resolved review thread(s) on {repo}#{pr}',
  'cli.pr.review.activity':
    '  {reviews} review(s), {comments} PR comment(s), {bots} review bot(s) — bodies in --json',
  'cli.pr.review.current': '  submitted against the current head {head}',
  'cli.pr.review.decision': '  review: {decision} by {author} at {submitted}',
  'cli.pr.review.none': 'no review thread is anchored to a line on {repo}#{pr}',
  'cli.pr.review.stale':
    '  submitted against {commit}; the head is now {head} ({committed}) — this decision predates the current code',
  'cli.pr.review.truncated':
    '  more than {count} threads — this is the first page, not the whole review',
  'cli.pr.review.undecided': '  GitHub reports no review decision yet',
  'cli.pr.thread.closed': '  resolved    {path}:{line}  {id}',
  'cli.pr.thread.comment': '    {author} at {createdAt}',
  'cli.pr.thread.more': '    {hidden} more comment(s) on this thread',
  'cli.pr.thread.open': '  unresolved  {path}:{line}  {id}',
  'cli.pr.thread.outdated':
    '    the diff has moved under this thread — {line} is where the comment was written',
  // The banner a `--only` run carries, in front of whichever summary above it renders. Rendered
  // output, so it lives here — `data.notAGateRun` is the machine marker, and a reader testing for
  // one narrowed run reads that boolean rather than substring-matching this line.
  'cli.verify.notAGateRun': 'NOT A GATE RUN — {summary}',
  'cli.verify.pass': 'all {count} steps passed in {ms}ms',
  'cli.verify.fail': '{failed} of {count} steps failed',
  'cli.verify.plan':
    'the gate in {parts} part(s) over {steps} steps — the CI matrix is data.matrix',
  // The budgets step built before it weighed (`verify-budgets-build.ts`): which stats state made it.
  'cli.verify.budgets.built':
    'built first: build stats were {state} — x build --target static --out {out} ({ms}ms)',
  // A skipped step is not a passed one, so the two counts never share a sentence — and the skipped
  // ones are named, because "which suite has nothing to run here?" is the question a green gate
  // over a missing suite has to answer on its own line. Whole sentences per case rather than a
  // clause the caller glues on: a catalog clause cannot know the sentence it lands in.
  'cli.verify.passSkipped':
    '{passed} of {count} steps passed in {ms}ms — {skipped} skipped: {names}',
  'cli.verify.failSkipped': '{failed} of {count} steps failed — {skipped} skipped: {names}',
  // The `errors` step's own coverage, in `output`: a scan without a parser reads most fix lines
  // and not all of them, and a step that reports findings alone claims a completeness it lacks.
  // `contract-diff`'s baseline whenever it is not HEAD's file (`verify-contract-diff.ts`).
  'cli.verify.contract.mergeBase': 'baseline: {file} at the merge base with {ref}',
  'cli.verify.contract.baseTip':
    'baseline: {file} at {ref} — a shallow checkout reaches no merge base with it',
  'cli.verify.contract.baseUnfetched':
    '{ref} is not fetched, so {file} at HEAD is the baseline — run `{fix}` for the merge base',
  'cli.verify.contract.noCheckout': 'not a git checkout: {file} on disk is the baseline',
  'cli.verify.contract.noCommit': 'no commit yet: no published {file} to break',
  'cli.verify.contract.uncommitted': '{file} is not committed at {rev}: nothing published to break',
  'cli.verify.contract.notManifest': '{file} at {rev} is not a manifest: no baseline',
  // A step standing down while the app's load is red (`load-findings.ts`).
  'cli.verify.loadBlocked': 'skipped: load failed (see {owner})',
  'cli.verify.fixCoverage': 'checked {checked} fix line(s), could not read {unreadable}',
  // The `drift` step on an app whose only store is a `defineDriver` one: migrations describe
  // Postgres, and that store owns its schema — said in `output`, so the step is not a silent green.
  'cli.verify.driftNonSql':
    'skipped: no SQL driver is configured — the app stores rows in {stores}, which owns its schema; migrations, drift and x db describe Postgres only',
  // Why a skipped step is a dash when the step can say so: the suite exists and not one of its
  // tests ran. Each test's own name carries the reason it skipped, and `bun test` prints only the
  // counts — so the line says how many and `x test <type>` prints the names.
  'cli.verify.allSkipped': 'found {skipped} test(s) and every one skipped itself',
  'cli.verify.warnings': '{count} warning(s) — --verbose or --json lists them',
  'cli.verify.slowest': 'slowest: {files}',
  'cli.verify.isrQueryOmitted':
    '{file}: reads the query parameter "{name}", which revalidate.query does not list — the page is stored under a key without it, so every visitor gets the document rendered for whichever value arrived first. Declare query: [{declared}], or stop reading it',
  // The other shape the same counts can take: a suite that reported no test at all, skipped ones
  // included. Its own line and not `allSkipped` with a zero, because the repair differs — there is
  // no skipped test to read a reason off, so the files the step selected hold no test.
  'cli.verify.ranNothing': 'found no test to run in the file(s) it selected',
  'cli.verify.merged': 'merged {parts} part(s) — {summary}',
  // The heartbeat `verify-progress.ts` writes while a step is still running: `{steps}` is
  // `unit (12m 3s), live (4m 0s)`, each step with the time since it started.
  'cli.verify.stillRunning': 'still running: {steps}',
  // The `unit` step's own measurement, in `output`: what the suite covered of the app's whole
  // source tree, beside the floor it was held to. A shard says it measured a slice instead.
  'cli.verify.coverage':
    'coverage: {lines}% of lines, {funcs}% of functions over {files} source file(s) — floor {floor}',
  'cli.verify.coverageDeferred':
    'coverage: this shard measured its own slice — x verify merge folds every shard and judges the floor',
  'cli.verify.serial': 'serial',
  'cli.verify.workers': '{workers} workers',
} as const;
