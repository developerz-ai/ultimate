/**
 * The API surface: every action, mutator, query, job and task Postly exposes, registered in one
 * call. Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles, MCP tools and
 * test scaffolds.
 *
 * `defineApi` takes whole modules, so the export name IS the primitive's name: there is no
 * second list of strings to keep in step with the declarations, and adding an action to a
 * feature is one edit rather than two. Two features exporting one name collide at registration
 * with `X_ACTION_DUPLICATE`.
 *
 * That is why the jobs and the task are handed over here too. A job or task module that nothing
 * registers keeps the positional name `job()` gave it — `anonymous-job-2` on the queue row, in
 * `x.manifest.json` and in every dead-letter trace, a name that appears nowhere in this source.
 *
 * Importing this module IS the boot — the call below runs on import, and nothing else registers
 * anything. Its importer is the framework's own module scan, which dynamic-imports every file
 * under an app's surface directories; that is what backs `x manifest`, `x routes`, `x dev`,
 * `x verify` and `apps/web/server.ts` — the production entry the image starts, which runs the
 * same scan rather than keeping a second import list that could disagree with this one.
 */

// `mcpConfirmations()` returns an ACTION — the one a person approves an agent's gated call with —
// so it registers here like any other. From its own module: `@postly/mcp`'s index builds the MCP
// server, which snapshots the registry and must load after this call, never inside it.
import * as mcpConfirmationActions from '@postly/mcp/confirmations';
import { defineApi } from '@ultimat3/action';
// One module per primitive — the directory form `x g` writes (`<slice>/actions/<name>.ts`), each
// bound under its own file's name. A factory's kind decides its list, never its file: a mutator,
// a transition and an `llm()`/`agent()`/`hive()` call are actions; a backfill, a notifier, a
// scrape, a webhook delivery, an export and an `agentJob()` are jobs.
import * as endSession from '../app/auth/actions/end-session';
import * as erasureApprovalOptions from '../app/auth/actions/erasure-approval-options';
import * as passkeyRegisterOptions from '../app/auth/actions/passkey-register-options';
import * as passkeySignIn from '../app/auth/actions/passkey-sign-in';
import * as passkeySignInOptions from '../app/auth/actions/passkey-sign-in-options';
import * as registerPasskey from '../app/auth/actions/register-passkey';
import * as planCatalog from '../app/billing/backfills/plan-catalog';
import * as planPrices from '../app/billing/jobs/plan-prices';
import * as postCharge from '../app/billing/jobs/post-charge';
import * as settleUpgrade from '../app/billing/jobs/settle-upgrade';
import * as contactSales from '../app/contact/actions/contact-sales';
import * as sendSalesReceipt from '../app/contact/jobs/send-sales-receipt';
import * as deliverDigest from '../app/digest/jobs/deliver-digest';
import * as sendDigest from '../app/digest/jobs/send-digest';
import * as nightlyDigest from '../app/digest/tasks/nightly-digest';
import * as openErrorIssue from '../app/errors/jobs/open-error-issue';
import * as purgeMcpConfirmations from '../app/mcp/jobs/purge-mcp-confirmations';
import * as hourlyPurge from '../app/mcp/tasks/hourly-purge';
import * as attachAvatar from '../app/orgs/actions/attach-avatar';
import * as grantAvatarUpload from '../app/orgs/actions/grant-avatar-upload';
import * as inviteMember from '../app/orgs/actions/invite-member';
import * as memberAvatar from '../app/orgs/actions/member-avatar';
import * as upgradePlan from '../app/orgs/actions/upgrade-plan';
import * as onboardOrg from '../app/orgs/jobs/onboard-org';
import * as sendInvite from '../app/orgs/jobs/send-invite';
import * as warmAvatar from '../app/orgs/jobs/warm-avatar';
import { PARTNER_SCOPES, resolvePartnerToken } from '../app/partners/oauth';
import * as abortPostsImport from '../app/posts/actions/abort-posts-import';
import * as completePostsImport from '../app/posts/actions/complete-posts-import';
import * as createComment from '../app/posts/actions/create-comment';
import * as createPost from '../app/posts/actions/create-post';
import * as grantPostsImport from '../app/posts/actions/grant-posts-import';
import * as keepDraftReview from '../app/posts/actions/keep-draft-review';
import * as likePost from '../app/posts/actions/like-post';
import * as listPostsImportParts from '../app/posts/actions/list-posts-import-parts';
import * as movePostStatus from '../app/posts/actions/move-post-status';
import * as postAttachment from '../app/posts/actions/post-attachment';
import * as printPost from '../app/posts/actions/print-post';
import * as publishPost from '../app/posts/actions/publish-post';
import * as requestDraftReview from '../app/posts/actions/request-draft-review';
import * as requestPostsExport from '../app/posts/actions/request-posts-export';
import * as reviewDraft from '../app/posts/actions/review-draft';
import * as signPostsImportPart from '../app/posts/actions/sign-posts-import-part';
import * as summarize from '../app/posts/actions/summarize';
import * as summarizePosts from '../app/posts/actions/summarize-posts';
import * as withdrawPost from '../app/posts/actions/withdraw-post';
import * as postExcerpts from '../app/posts/backfills/post-excerpts';
import * as reindexPosts from '../app/posts/backfills/reindex-posts';
import * as commentPosted from '../app/posts/jobs/comment-posted';
import * as dailyLikesRollup from '../app/posts/jobs/daily-likes';
import * as exportPosts from '../app/posts/jobs/export-posts';
import * as importPosts from '../app/posts/jobs/import-posts';
import * as likeTotalsRefresh from '../app/posts/jobs/like-totals';
import * as notifySubscribers from '../app/posts/jobs/notify-subscribers';
import * as postsQuotaWarning from '../app/posts/jobs/posts-quota-warning';
import * as purgeImports from '../app/posts/jobs/purge-imports';
import * as reviewDraftLater from '../app/posts/jobs/review-draft-later';
import * as liveFeed from '../app/posts/live/live-feed';
import * as feedActivity from '../app/posts/queries/feed-activity';
import * as orgPosts from '../app/posts/queries/org-posts';
import * as postById from '../app/posts/queries/post-by-id';
import * as postBySlug from '../app/posts/queries/post-by-slug';
import * as postLikesByDay from '../app/posts/queries/post-likes-by-day';
import * as postRecord from '../app/posts/queries/post-record';
import * as postReview from '../app/posts/queries/post-review';
import * as postRevisions from '../app/posts/queries/post-revisions';
import * as publicPost from '../app/posts/queries/public-post';
import * as publicPostSlugs from '../app/posts/queries/public-post-slugs';
import * as publicPosts from '../app/posts/queries/public-posts';
import * as hourlyLikes from '../app/posts/tasks/hourly-likes';
import * as maintainPartitions from '../app/quota/jobs/partitions';
import * as quotaAlert from '../app/quota/jobs/quota-alert';
import * as quotaAlertSms from '../app/quota/jobs/quota-alert-sms';
import * as answerPrompt from '../app/runs/actions/answer-prompt';
import * as cancelRun from '../app/runs/actions/cancel-run';
import * as connectSite from '../app/runs/actions/connect-site';
import * as issueRunKey from '../app/runs/actions/issue-run-key';
import * as revokeRunKey from '../app/runs/actions/revoke-run-key';
import * as startRun from '../app/runs/actions/start-run';
import * as printStatement from '../app/runs/jobs/print-statement';
import * as purgeRetained from '../app/runs/jobs/purge-retained';
import * as syncConnection from '../app/runs/jobs/sync-connection';
import { ORG_KEY_SCOPES, resolveOrgKey } from '../app/runs/keys';
import * as liveRunEvents from '../app/runs/live/live-run-events';
import * as runConnections from '../app/runs/queries/run-connections';
import * as runHealth from '../app/runs/queries/run-health';
import * as hourlyRetention from '../app/runs/tasks/hourly-retention';
import * as registerDevice from '../app/settings/actions/register-device';
import * as requestMemberErasure from '../app/settings/actions/request-member-erasure';
import * as requestMemberExport from '../app/settings/actions/request-member-export';
import * as savePreferences from '../app/settings/actions/save-preferences';
import * as setTheme from '../app/settings/actions/set-theme';
import * as subscribePush from '../app/settings/actions/subscribe-push';
import * as toggleDigestOptIn from '../app/settings/actions/toggle-digest-opt-in';
import * as unregisterDevice from '../app/settings/actions/unregister-device';
import * as unsubscribePush from '../app/settings/actions/unsubscribe-push';
import * as eraseMember from '../app/settings/jobs/erase-member';
import * as exportMember from '../app/settings/jobs/export-member';
import * as addWebhookEndpoint from '../app/webhooks/actions/add-webhook-endpoint';
import * as removeWebhookEndpoint from '../app/webhooks/actions/remove-webhook-endpoint';
import * as billingEventsReceiver from '../app/webhooks/jobs/billing-events-receiver';
import * as postPublishedWebhook from '../app/webhooks/jobs/post-published-webhook';
// `defineService(...)` and the channel declaration run on import — the same "importing IS the
// boot" rule as the registration below, so `ctx.orgs`, `ctx.posts`, `ctx.runs` and `ctx.webhooks`
// are installed wherever this module has run, including tests.
import '../app/orgs/service';
import '../app/posts/channels';
import '../app/posts/service';
import '../app/runs/service';
import '../app/webhooks/service';

export const api = defineApi({
  actions: [
    endSession,
    passkeySignInOptions,
    passkeySignIn,
    passkeyRegisterOptions,
    registerPasskey,
    erasureApprovalOptions,
    contactSales,
    inviteMember,
    upgradePlan,
    grantAvatarUpload,
    attachAvatar,
    memberAvatar,
    createPost,
    publishPost,
    printPost,
    withdrawPost,
    postAttachment,
    createComment,
    requestPostsExport,
    // An export file coming back in parts: the five calls `uploadFile({ multipart })` makes.
    grantPostsImport,
    signPostsImportPart,
    listPostsImportParts,
    completePostsImport,
    abortPostsImport,
    summarize,
    summarizePosts,
    reviewDraft,
    keepDraftReview,
    requestDraftReview,
    connectSite,
    startRun,
    answerPrompt,
    cancelRun,
    issueRunKey,
    revokeRunKey,
    savePreferences,
    requestMemberExport,
    requestMemberErasure,
    subscribePush,
    unsubscribePush,
    registerDevice,
    unregisterDevice,
    addWebhookEndpoint,
    removeWebhookEndpoint,
    mcpConfirmationActions,
  ],
  // A mutator IS an action, so it registers as one: the optimistic local twin rides on the same
  // declaration instead of living in a parallel registry with a parallel authz path.
  mutators: [likePost, movePostStatus, setTheme, toggleDigestOptIn],
  queries: [
    liveFeed,
    orgPosts,
    postRecord,
    postById,
    feedActivity,
    postLikesByDay,
    postReview,
    postRevisions,
    publicPost,
    publicPosts,
    publicPostSlugs,
    postBySlug,
    liveRunEvents,
    runConnections,
    runHealth,
  ],
  // Named jobs keep their own durable names (`runs.sync`, `posts.published.webhook`, a backfill's
  // ledger key); every other job's export name is its queue key.
  jobs: [
    notifySubscribers,
    postsQuotaWarning,
    quotaAlert,
    quotaAlertSms,
    maintainPartitions,
    exportPosts,
    importPosts,
    commentPosted,
    reviewDraftLater,
    postExcerpts,
    reindexPosts,
    dailyLikesRollup,
    likeTotalsRefresh,
    onboardOrg,
    sendInvite,
    sendDigest,
    deliverDigest,
    sendSalesReceipt,
    syncConnection,
    printStatement,
    warmAvatar,
    purgeMcpConfirmations,
    purgeRetained,
    purgeImports,
    postPublishedWebhook,
    billingEventsReceiver,
    planPrices,
    planCatalog,
    settleUpgrade,
    postCharge,
    openErrorIssue,
    exportMember,
    eraseMember,
  ],
  tasks: [nightlyDigest, hourlyPurge, hourlyLikes, hourlyRetention],
  // A second door for machine callers, onto actions a browser already calls: same handler, same
  // policy, an org's bearer key instead of a session. `/api/runs/start` is `/v1/runs/start`, and
  // publishPost's pinned `/api/posts/:postId/publish` is `/v1/posts/:postId/publish`.
  // And one for a partner's machine: the public blog's reads, behind a client-credentials token
  // from Postly's own authorization server (`app/partners/oauth.ts`) instead of an org key.
  http: {
    mounts: [
      { prefix: '/v1', scopes: ORG_KEY_SCOPES, resolveToken: resolveOrgKey },
      { prefix: '/partner', scopes: PARTNER_SCOPES, resolveToken: resolvePartnerToken },
    ],
  },
});

/** What the typed client is shaped from — imported as a TYPE only by `shared/client.ts`. */
export type Api = typeof api;
