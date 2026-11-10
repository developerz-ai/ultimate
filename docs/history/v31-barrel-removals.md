# v31: names removed from each package's `.` barrel (plan 101 D10)

`.` is the app API; `./adapter` is for port and driver authors. Everything else a v30 barrel exported is internal from 31.0.0 ([Upgrading](../../wiki/Upgrading.md) entry 74).

`As of 2026-11-10`. Derived by diffing each package's 30.x `src/index.ts` against its 31.0.0 one, following every `export … from` list, and checking the name against the package's `./adapter` entry. 1,409 names left `.` across 30 packages: 46 are now on `./adapter`, 1,363 are no longer exported.

| Removed name | Fix |
|---|---|
| listed under "now on `./adapter`" | `import { … } from '@ultimat3/<pkg>/adapter'` |
| listed under "no longer exported", an error class or factory | match the error by its code: `isUltimateError(e) && e.code === 'X_…'` |
| listed under "no longer exported", a `*_ERROR_CODES` table | the package's `<Pkg>ErrorCode` type where it has one; otherwise compare `e.code` to the code string |
| listed under "no longer exported", anything else | the package's public API: the kept factory, and its option and result types |

| Package | Removed | Now on `./adapter` | No longer exported |
|---|---|---|---|
| `@ultimat3/action` | 30 | 1 | 29 |
| `@ultimat3/admin` | 112 | 1 | 111 |
| `@ultimat3/ai` | 38 | 2 | 36 |
| `@ultimat3/auth` | 41 | 4 | 37 |
| `@ultimat3/cache` | 21 | 0 | 21 |
| `@ultimat3/cli` | 22 | 0 | 22 |
| `@ultimat3/core` | 76 | 1 | 75 |
| `@ultimat3/db` | 52 | 2 | 50 |
| `@ultimat3/entity` | 27 | 0 | 27 |
| `@ultimat3/flags` | 18 | 0 | 18 |
| `@ultimat3/http` | 35 | 1 | 34 |
| `@ultimat3/i18n` | 8 | 0 | 8 |
| `@ultimat3/jobs` | 149 | 7 | 142 |
| `@ultimat3/mail` | 26 | 1 | 25 |
| `@ultimat3/manifest` | 10 | 0 | 10 |
| `@ultimat3/mcp` | 65 | 1 | 64 |
| `@ultimat3/money` | 14 | 0 | 14 |
| `@ultimat3/notify` | 25 | 3 | 22 |
| `@ultimat3/policy` | 11 | 0 | 11 |
| `@ultimat3/pwa` | 40 | 3 | 37 |
| `@ultimat3/query` | 26 | 2 | 24 |
| `@ultimat3/realtime` | 29 | 1 | 28 |
| `@ultimat3/render` | 27 | 1 | 26 |
| `@ultimat3/schema` | 13 | 3 | 10 |
| `@ultimat3/scraping` | 64 | 8 | 56 |
| `@ultimat3/seo` | 10 | 1 | 9 |
| `@ultimat3/storage` | 40 | 3 | 37 |
| `@ultimat3/testing` | 97 | 0 | 97 |
| `@ultimat3/time` | 23 | 0 | 23 |
| `@ultimat3/ui` | 260 | 0 | 260 |
| total | 1,409 | 46 | 1,363 |

## `@ultimat3/action`

Now on `./adapter`: `IdempotencyStatusUnknownError`.

No longer exported: `AUDIT_INPUT_MAX_DEPTH`, `AUDIT_SUBJECT_COLUMNS`, `ActionDeprecationInvalidError`, `ActionDuplicateError`, `ActionForeignError`, `ActionHttpPathInvalidError`, `ActionPathDuplicateError`, `ActionPathStyleInvalidError`, `ActionPolicyMissingError`, `ActionUnregisteredError`, `AuditSinkMissingError`, `BEARER_SCHEME`, `COOKIE_SCHEME`, `DEFAULT_IDEMPOTENCY_CONFIG`, `DEFAULT_IDEMPOTENCY_WINDOW_MS`, `DEFAULT_MAX_METER_KEYS`, `IDEMPOTENCY_STATUSES`, `IdempotencyNotSharedError`, `METER_PERIODS`, `MeterField`, `MeterInvalidError`, `OpenApiConfigInvalidError`, `TransitionValues`, `UNREPRESENTABLE`, `idempotencyConfig`, `operationTagOf`, `outputSchemaName`, `policyTestStubFor`, `toJobHandle`.

## `@ultimat3/admin`

Now on `./adapter`: `GatewayAdapter`.

No longer exported: `ACTION_INPUT_PREFIX`, `ACTION_NOT_APPLICABLE_REASON`, `ACTION_OPERATION`, `ACTION_PARAM`, `ADMIN_BATCH_JOB`, `ADMIN_ERROR_CODES`, `ADMIN_ERROR_TITLES`, `ADMIN_IMPERSONATE`, `ADMIN_OPERATIONS`, `ADMIN_RENDERERS`, `ANONYMOUS_ADMIN_ACTOR`, `AUDIT_PAGE_DEFAULT`, `AUDIT_PAGE_MAX`, `ActionInputControl`, `ActionInputField`, `AdminActionForm`, `AdminActionFormProps`, `AdminBatchBar`, `AdminBatchBarProps`, `AdminFilterBar`, `AdminFilterBarProps`, `AdminLookupRequest`, `AdminLookupResult`, `AdminRequestActor`, `AdminScopeTabs`, `AdminScopeTabsProps`, `AdminViewWriteError`, `AskedFilter`, `BATCH_MATCHING_REASON`, `BATCH_NOT_OFFERED_REASON`, `BATCH_OPERATION`, `CONFIRMATION_REQUIRED_REASON`, `CURSOR_PARAM`, `ComputedCell`, `DEFAULT_SECTION_KEY`, `DELETE_OPERATION`, `FILTER_OPS`, `FILTER_PREFIX`, `GuardedField`, `JOBS_PATH`, `JOB_ENTITY`, `LOOKUP_SEGMENT`, `LOOKUP_SELECT_MAX`, `OPERATION_FIELD`, `OperationDecision`, `OperationMatrix`, `RELATED_PAGE_SIZE`, `ROW_OUT_OF_SCOPE_REASON`, `RegisteredEntity`, `RegisteredTable`, `ResourceColumnsInput`, `SCOPE_PARAM`, `SORT_PARAM`, `TRUNCATE_AT`, `VIEW_OPERATIONS`, `WIDGET_BY_FIELD_TYPE`, `actionDecisions`, `actionFormHref`, `actionInputFields`, `adminBranding`, `adminColumnsOf`, `adminErrorFrom`, `adminLookup`, `adminMountAt`, `adminNav`, `adminPermissionFor`, `adminSealedColumnsOf`, `adminTablesOf`, `adminToolDecisions`, `anonymousAuthz`, `assertMoney`, `assertZone`, `auditEntry`, `auditRefusal`, `batchConfirmationToken`, `batchEnqueue`, `checkedFilter`, `computedRow`, `currencyFieldOf`, `declaredFilters`, `decodeActionInput`, `decodeAdminCursor`, `decodeForm`, `defaultBranding`, `describeAdmin`, `encodeAdminCursor`, `fetchPage`, `fieldTypeFromColumn`, `filterKindFor`, `filterOpsOf`, `filterParam`, `isAllowed`, `issueText`, `knownFilterParams`, `listQuery`, `lookupHref`, `matchingConfirmationToken`, `operationMatrix`, `pageNavItems`, `registerAdminMount`, `relationNeeds`, `requestActor`, `resourceColumns`, `resourceFor`, `rowWhere`, `scopeCounts`, `scopeNamed`, `themeAttributes`, `widgetContextOf`, `widgetFor`, `widgetProps`.

## `@ultimat3/ai`

Now on `./adapter`: `AiKeyMissingError`, `AiModelUnknownError`.

No longer exported: `AiDocumentBlock`, `AiDocumentSource`, `AiGatewayMissingError`, `AiImageBlock`, `AiImageSource`, `AiMediaBlock`, `AiModelUnresolvedError`, `AiPromptRenderError`, `AiPromptSecretError`, `AiPromptVersionError`, `BILLED_META`, `DEFAULT_GATEWAY_BREAKER`, `EFFORTS`, `EvalBaselineInvalidError`, `HiveEmptyError`, `IMAGE_MEDIA_TYPES`, `IMAGE_TOKEN_ESTIMATE`, `ImageMediaType`, `MAX_DOCUMENT_BASE64_CHARS`, `MAX_IMAGE_BASE64_CHARS`, `PgHybridArgs`, `PgVectorRowInput`, `StreamState`, `assertModel`, `baselineFrom`, `describeRegression`, `estimateTextTokens`, `getPrompt`, `isMediaBlock`, `modelIds`, `passthroughReranker`, `promptVersions`, `regressionsAgainst`, `requiresStreaming`, `totalTokens`, `writeBaseline`.

## `@ultimat3/auth`

Now on `./adapter`: `AuthTokenKind`, `DeviceDecision`, `DeviceStatus`, `RefreshRotation`.

No longer exported: `API_KEY_NAMESPACE`, `AUTH_CODE_TTL_MS`, `AUTH_ERROR_CODES`, `AUTH_ERROR_TITLES`, `AUTH_SERVER_METADATA_WELL_KNOWN`, `AUTH_SUBJECT_COLUMNS`, `AccountSchema`, `DEFAULT_MFA_ISSUER`, `DEFAULT_PASSKEY_CHALLENGE_TTL_MS`, `DEFAULT_PASSWORD_PARAMS`, `DEFAULT_SAML_EMAIL_ATTRIBUTES`, `DEFAULT_SAML_NAME_ATTRIBUTES`, `DEFAULT_SAML_SKEW_MS`, `IdentityRouteDescriptor`, `JwtBearerCheck`, `PasskeyAssertionResponse`, `PasskeyRegistrationResponse`, `SamlCheck`, `SessionDevice`, `SessionSchema`, `UserSchema`, `VerificationPurposeDef`, `VerificationSchema`, `authLimiterNotShared`, `authLimiterPolicyMismatch`, `decodeIdToken`, `idTokenEmailVerified`, `listDevices`, `mfaRequiredUnenforceable`, `mfaSecretInvalid`, `mfaSecretUnsealed`, `oauthAccountNotLinked`, `oauthLinkingDisabled`, `oauthProviderDuplicate`, `oauthStateInvalid`, `oauthTokenInvalid`, `verificationPurposeNames`.

## `@ultimat3/cache`

No longer exported: `CACHE_ERROR_CODES`, `CACHE_ERROR_TITLES`, `CDN_PURGE_ENV_KEYS`, `CLOUDFLARE_MAX_TAGS_PER_REQUEST`, `CacheJitterInvalidError`, `CacheLimitInvalidError`, `CacheTagUnknownError`, `CacheTtlInvalidError`, `DEFAULT_PURGE_TIMEOUT_MS`, `DEFAULT_REDIS_MAX_VALUE_BYTES`, `FASTLY_API_URL`, `FASTLY_MAX_KEYS_PER_REQUEST`, `FENCE_MEMORY`, `LruStats`, `PUBLISHER_CONNECT_WAIT_MS`, `clearMemo`, `cosineSimilarity`, `graphSize`, `graphSnapshot`, `memoSize`, `tagsFor`.

## `@ultimat3/cli`

No longer exported: `BuildEntryMissingError`, `BunVersionError`, `COMMANDS`, `CatalogExistsError`, `DeclarationUnknownError`, `ErrorCodeUnknownError`, `FixTargetUnknownError`, `HousekeepingOptions`, `HousekeepingReport`, `JOBS_SUBCOMMANDS`, `JobUnknownError`, `NoTestFilesError`, `NotInAppError`, `QuerySubscribesUnknownError`, `ROBOTS_PATH`, `RoleUnknownError`, `SITEMAP_PATH`, `VerifyFailedError`, `checkLockstep`, `migratedTemplate`, `staticFix`, `tidyTestState`.

## `@ultimat3/core`

Now on `./adapter`: `FailureCaptureLimits`.

No longer exported: `ACTOR_KINDS`, `APP_VERSION_KEY`, `AssetsSection`, `CACHE_TEMP_GRACE_MS`, `CLIENT_VITALS_SURFACES`, `ClientErrorsSection`, `DECLARED_ERRORS_EXTENSION`, `DEFAULT_IMAGE_QUALITY`, `DEFAULT_MAX_SERIES`, `DEFAULT_ROLE`, `DEFAULT_SAMPLE_RATIO`, `DRAIN_DEADLINE_MAX_MS`, `EnvVarSummary`, `EnvVarType`, `ErrorText`, `ExerciseEnvironmentError`, `ExerciseUnscopedError`, `ExportedLogRecord`, `FailureActor`, `FailureCaptureSection`, `FrameworkEventMap`, `FrameworkEventName`, `HeldFailure`, `INBOX_RETENTION_KEYS`, `IslandsSection`, `LogRecordEvent`, `MAX_RENDERED_LENGTH`, `MailSection`, `NavigationSection`, `OtlpAnyValue`, `OtlpKeyValue`, `OutboundRequestEvent`, `OutboxDrainMessage`, `PROBE_DATABASE_MIN_AGE_MS`, `PROBE_DATABASE_NAME_MAX`, `PWA_COLOR_KEYS`, `PWA_SCHEMES`, `READINESS_GRACE_MAX_MS`, `RenderIsrRegenerateEvent`, `SEAL_VERSION`, `SECRETS_ERROR_CODES`, `SECRETS_KEY_MODE`, `SHUTDOWN_PHASES`, `SPECULATION_EAGERNESS`, `STORE_MODES`, `SealInvalidReason`, `SecretsEnvelope`, `SiteSections`, `TimeSection`, `actorOrigin`, `budgetHeaders`, `defaultSampler`, `describeEnv`, `failureCaptureLimits`, `formatError`, `imageFromBunError`, `imageTooLarge`, `impersonationReason`, `isErrorRetry`, `isSpanId`, `isTraceId`, `listeningOrigins`, `otlpEndpoint`, `otlpLogsRequest`, `parseColor`, `probeDatabaseAlive`, `ratioSampler`, `readProcess`, `resetFailureCaptureWindows`, `resetProcessMetrics`, `samplerFromEnv`, `secretsPath`, `serviceResource`, `statementStacksCaptured`, `withSpanContext`.

## `@ultimat3/db`

Now on `./adapter`: `defaultClient`, `loadPgliteDriver`.

No longer exported: `DESTRUCTIVE_CAUSE`, `DbNode`, `FRAMEWORK_TABLE_PREFIX`, `HISTORY_GUARD_TRIGGER`, `HISTORY_TRIGGER`, `MAX_FAILURE_LIST`, `PARTITION_FUNCTION`, `POSITION_CACHE_MS`, `READONLY_TIMEOUT_MS`, `ROW_SECURITY_POLICY`, `ReplayReader`, `RowSecurityPlanInput`, `TENANT_SETTING`, `TenantTable`, `assumeRole`, `branchExists`, `buildSchema`, `checkClauses`, `columnCheckName`, `columnNamesConstraint`, `constraintExpressionUnsafe`, `counterTrigger`, `counterTriggerName`, `declaredTriggers`, `dropRowSecuritySql`, `ensureRowSecurityRoles`, `findTable`, `generatedExpressionUnsafe`, `grantReadOnlySql`, `indexOrderInvalid`, `indexPredicateUnsafe`, `isIndexMethod`, `isSqlFragment`, `migrateConcurrent`, `migrationConcurrentInTransaction`, `migrationConflict`, `migrationStamp`, `migrationViewDepends`, `migratorOwnershipSql`, `partitionDropped`, `readLocal`, `replayReader`, `replicaScope`, `rowSecurityAfter`, `rowSecurityExemption`, `rowSecurityPlan`, `rowSecurityRole`, `serializationExhausted`, `sqlStateCode`, `sqlUnsafe`.

## `@ultimat3/entity`

No longer exported: `DEFAULT_PARTITIONS_AHEAD`, `DEFAULT_SEARCH_COLUMN`, `DEFAULT_SEARCH_LANGUAGE`, `DEFAULT_SEARCH_LIMIT`, `DEFAULT_SEARCH_WEIGHT`, `DescribeInput`, `IllegalTransition`, `PERSONAL_DATA_KINDS`, `QueryLoopBatch`, `WriteLoopBatch`, `crossTenantDenied`, `isSearchLanguage`, `isSearchWeight`, `movesFrom`, `nPlusOneQuery`, `nPlusOneWrite`, `partitionInvalid`, `personalDataKindOf`, `repoClientPinned`, `searchInMemory`, `searchUndeclared`, `stateConflict`, `stateTransitionIllegal`, `stateUndeclared`, `tenancyActorMismatch`, `tenancyUnscoped`, `writeUnfiltered`.

## `@ultimat3/flags`

No longer exported: `BUILT_IN_SUBJECT_KINDS`, `BuiltInSubjectKind`, `DEFAULT_REPORT_INTERVAL_MS`, `FLAGS_ERROR_CODES`, `FLAGS_ERROR_TITLES`, `FLAG_KINDS`, `FlagExpiryIsMandatory`, `FlagSubjectVia`, `allFlags`, `bucketOf`, `flagDuplicate`, `flagExpired`, `flagSubjectRequired`, `flagTargetingInvalid`, `flagUnknown`, `hasFlag`, `resetFlagReporting`, `resetFlags`.

## `@ultimat3/http`

Now on `./adapter`: `rateLimitStoreUnavailable`.

No longer exported: `BUN_MAX_IDLE_TIMEOUT_S`, `DEFAULT_MAX_REQUEST_BODY_BYTES`, `DEFAULT_WEBHOOK_TOLERANCE_MS`, `ErrorPageAction`, `ErrorPageCopy`, `ErrorPageGroup`, `ErrorPageOptions`, `HTTP_METHODS`, `IDLE_TIMEOUT_MARGIN_S`, `InboundCorrelation`, `OverlayMeta`, `REDIS_RATE_LIMIT_TAKE`, `bearerMountInvalid`, `corsHeaders`, `errorPageResponse`, `errorStatusInvalid`, `noContent`, `overlayResponse`, `pathInvalid`, `peerIdentity`, `pipelineNoResponse`, `rateLimitBucketConflict`, `rateLimitBucketUnbound`, `rateLimitNotShared`, `rateLimitScopeUnset`, `requestBodyTooLarge`, `resolveErrorPageCopy`, `routeCacheInvalid`, `routeConflict`, `serverNotStarted`, `tenantBucketUnknown`, `trustProxyUnset`, `webhookSignatureInvalid`, `webhookSignatureStale`.

## `@ultimat3/i18n`

No longer exported: `I18N_ERROR_CODES`, `I18N_ERROR_TITLES`, `PLURAL_CATEGORIES`, `assertCatalogsComplete`, `assertCatalogsRegistered`, `familyStems`, `localeCookieOf`, `localeUnsupported`.

## `@ultimat3/jobs`

Now on `./adapter`: `AckOptions`, `ClaimQueuesEmptyError`, `HeartbeatOptions`, `JobNotRequeueableError`, `JobRowStatusUnknownError`, `SettleBy`, `fireThroughDriver`.

No longer exported: `ActionJobUnbridgedError`, `BackfillAppliedError`, `BackfillEnvironmentError`, `BackfillMigrationPendingError`, `BackfillReport`, `BackfillSourceInvalidError`, `BackfillStalledError`, `BackfillVerdict`, `CONSUMER_PROGRESS_NOTE`, `COUNTER_BUCKET_MS`, `CancelUnsupportedError`, `CompensateContext`, `ConsumerBatch`, `ConsumerInvalidError`, `ConsumerReport`, `ConsumerSelfEnqueueError`, `CounterOutcome`, `DEFAULT_CONSUMER_BATCH`, `DEFAULT_EXPORT_BATCH`, `DEFAULT_EXPORT_MAX_PART_BYTES`, `DEFAULT_IMPORT_BATCH`, `DEFAULT_IMPORT_MAX_RECORD_BYTES`, `DEFAULT_IMPORT_MAX_ROW_ERRORS`, `DEFAULT_IMPORT_PAGE_BYTES`, `DEFAULT_LOCK_POLL_MS`, `DEFAULT_MAX_WEBHOOK_ATTEMPTS`, `DEFAULT_PARTITIONS_CRON`, `DEFAULT_PARTITIONS_NAME`, `DEFAULT_SUBJECT_BATCH`, `DispatchedOccurrence`, `EXPORT_EXTENSION`, `EXPORT_PART_DIGITS`, `EventSince`, `ExportFormat`, `ExportManifest`, `ExportPartTooLargeError`, `ExportRecord`, `ExportReport`, `ExportRowInvalidError`, `IdempotencyRequiredError`, `ImportHeaderMismatchError`, `ImportObject`, `ImportRecordTooLargeError`, `ImportRejection`, `ImportReport`, `ImportRowError`, `ImportTooManyErrorsError`, `JobActor`, `JobCompensationFailedError`, `JobConcurrencyInvalidError`, `JobConcurrencyKeyInvalidError`, `JobDeclarationInvalidError`, `JobEnqueueBatchTooLargeError`, `JobEventInvalidError`, `JobMaxAttemptsError`, `JobNameTakenError`, `JobNotPromotableError`, `JobNotRemovableError`, `JobOnSettledFailedError`, `JobPageInvalidError`, `JobSlotLostError`, `JobTenantRequiredError`, `LEASE_RENEWALS_PER_TTL`, `LedgerEntryInvalidError`, `LedgerPostingConflictError`, `LedgerReport`, `LedgerUnbalancedError`, `LimitKey`, `LimitReason`, `LockLostError`, `LockNotAcquiredError`, `LockStoreMissingError`, `MAX_CONCURRENCY_KEY_LENGTH`, `MAX_ERROR_STACK_LENGTH`, `MAX_PROGRESS_NOTE_LENGTH`, `MAX_WORKER_IN_FLIGHT`, `MIN_LEDGER_ENTRIES`, `MemoryLedgerBook`, `OutboxNoTxError`, `PAUSE_RECHECK_MS`, `PROGRESS_INTERVAL_MS`, `PartitionsReport`, `PartitionsTableReport`, `ReceivedEvent`, `RefreshViewInvalidError`, `RefreshViewReport`, `RollupInvalidError`, `RollupReport`, `StepCompensateUndeclaredError`, `StepDuplicateError`, `StepNotResolvableError`, `StepOutcomeUnknownError`, `StepOutputUnserializableError`, `StepRunOptions`, `SubjectCycleError`, `SubjectExportReport`, `SubjectIndexEntry`, `SubjectRef`, `SubjectTableUndeclaredError`, `SubjectTargetPage`, `SubjectTreatmentInvalidError`, `TaskJobResult`, `WEBHOOK_CONTENT_TYPE`, `WEBHOOK_RECEIVER_RETRY_AFTER_SECONDS`, `WHEN_BUSY`, `WebhookAnswer`, `WebhookDeliveryFailedError`, `WebhookDeliveryRejectedError`, `WebhookDeliveryThrottledError`, `WebhookEndpointDisabledError`, `WebhookEndpointInvalidError`, `WebhookEndpointUnknownError`, `WebhookEvent`, `WebhookEventIdInvalidError`, `WebhookEventInvalidError`, `WebhookEventUnknownError`, `WebhookHandleArgs`, `WebhookInbound`, `WebhookReceiverInvalidError`, `WebhookReceiverUnavailableError`, `WebhookReport`, `WhenBusy`, `assertSamePosting`, `backfillForRun`, `checkBackfillEnvironment`, `consumerDeclarationOf`, `csvHeader`, `currentLeader`, `decideBackfill`, `exportManifestKey`, `exportPartKey`, `failureForRow`, `isConsumer`, `lockLeaseKey`, `memoryLedgerBook`, `plannedSubject`, `queueDeadJobs`, `queueOldestReady`, `recordQueueDeadJobs`, `recordQueueOldestReady`, `retainedEntities`, `tenantKeyFrom`.

## `@ultimat3/mail`

Now on `./adapter`: `SendFailure`.

No longer exported: `AddressRefusal`, `BASE_LAYOUT`, `DarkRule`, `DeliveryEventKind`, `DeliveryOutcome`, `DeliveryReceiver`, `MAIL_ERROR_CODES`, `MAIL_ERROR_RETRY`, `MAIL_ERROR_TITLES`, `PREVIEW_RECIPIENT`, `addressInvalid`, `baseLayout`, `layoutFor`, `layoutUnknown`, `localeMissing`, `mailCredentialMissing`, `mailDuplicate`, `mailLayoutDuplicate`, `mailTransform`, `previewMissing`, `sendById`, `sesEndpoint`, `templateUnknown`, `textMissing`, `transformFailed`.

## `@ultimat3/manifest`

No longer exported: `AgentsMdMissingError`, `AgentsMdTooLargeError`, `MANIFEST_ERROR_CODES`, `MANIFEST_ERROR_TITLES`, `ManifestBreakingError`, `ManifestDriftError`, `formatDiff`, `isCompatible`, `manifestJson`, `scanPackageDocs`.

## `@ultimat3/mcp`

Now on `./adapter`: `McpConfirmationContestedError`.

No longer exported: `DEFAULT_MCP_BODY_LIMIT_BYTES`, `DEFAULT_MCP_CONFIRMATION_TTL_MS`, `DELETE_RESOURCE`, `DESCRIBE_RESOURCE`, `DOCS_TOOL`, `DescribedAction`, `INVALID_PARAMS`, `INVALID_REQUEST`, `JOB_STATUS_TOOL`, `LIST_RESOURCES`, `LIST_TENANTS`, `MANAGE_RESOURCE`, `MCP_CONFIRMATION_ARGUMENTS_PURPOSE`, `MCP_CONFIRMATION_DIGEST_PURPOSE`, `MCP_CONFIRMATION_SIGNING_PURPOSE`, `MCP_ERROR_CODES`, `MCP_ERROR_TITLES`, `META_TOOL_NAMES`, `META_UNKNOWN_FIX`, `McpAuditorInput`, `McpCatalogNameSource`, `McpCatalogToolDuplicateError`, `McpCatalogUnresolvedError`, `McpConfirmationDecision`, `McpEffectConflictError`, `McpEffectUndeclaredError`, `McpIncludeEarlyError`, `McpJobToolInvalidError`, `McpOAuthInvalidError`, `McpRecipeExampleInvalidError`, `McpRecipeLinkDanglingError`, `McpRecipeToolUnknownError`, `McpRecipeUnknownError`, `McpRecipeUriReservedError`, `McpUserConfirmationRequiredError`, `McpWrongToolError`, `PARSE_ERROR`, `READ_RESOURCE`, `RECIPE_URI_PREFIX`, `RESOURCE_URIS`, `RemoteToolOutput`, `SPLIT_DISPATCHERS`, `UiInteractStep`, `UiScopes`, `UiViewportName`, `WRITE_RESOURCE`, `auditToolCall`, `confirmationSigningPayload`, `effectOf`, `graphQuestion`, `isJsonRpcRequest`, `mcpAuditor`, `metadataPaths`, `metadataUrlFor`, `outcomeForCode`, `promptFromPath`, `protectedResourceMetadata`, `recipeFromMarkdown`, `recipeUri`, `renderRecipe`, `resultResponse`, `toPrompts`, `toolForEffect`, `withConfirmations`.

## `@ultimat3/money`

No longer exported: `MONEY_ERROR_CODES`, `MONEY_ERROR_TITLES`, `allocationInvalid`, `assertAllocationSums`, `assertScale`, `currencyDeclarationInvalid`, `currencyMismatch`, `currencyRedefined`, `currencyRequired`, `currencySymbol`, `rateMissing`, `rescaleNotExact`, `scaleInvalid`, `scaleNotWidening`.

## `@ultimat3/notify`

Now on `./adapter`: `DeliveryRecord`, `DeliveryStatus`, `DigestBucket`.

No longer exported: `APNS_KEY_ENV`, `DATA_PUSH_MAX_KEYS`, `DATA_PUSH_MAX_VALUE`, `DEFAULT_INBOX_PAGE`, `DEFAULT_MAX_RECIPIENTS`, `DEFAULT_NATIVE_PUSH_DEADLINE_MS`, `DELIVERY_STATUSES`, `FCM_KEY_ENV`, `IN_APP_CHANNEL`, `MAIL_CHANNEL`, `NOTIFY_ERROR_CODES`, `NotifyPlan`, `NotifyReport`, `PUSH_CHANNEL`, `PUSH_PLATFORMS`, `PushData`, `ResolvedDelivery`, `SMS_CHANNEL`, `isBulkChannel`, `isDeliveryStatus`, `isSmsNumber`, `recipientSchema`.

## `@ultimat3/policy`

No longer exported: `POLICY_ERROR_CODES`, `POLICY_ERROR_TITLES`, `emptyClauseList`, `enforceJob`, `enforceLive`, `enforceMcp`, `renderTrace`, `resetPolicyTracing`, `roleMapGeneration`, `roleRedefined`, `verbOf`.

## `@ultimat3/pwa`

Now on `./adapter`: `PostgresPushSubscriptionStoreOptions`, `PushSubscriptionKeys`, `VapidSigner`.

No longer exported: `BuildIdMissingError`, `PAGES_CLEARED_MESSAGE`, `PUSH_RECORD_SIZE`, `PUSH_SEND_TIMEOUT_MS`, `PUSH_URGENCIES`, `PWA_ERROR_CODES`, `PWA_ERROR_TITLES`, `PushEncryptOptions`, `PushEncryptionKeys`, `PushSendInput`, `PushSendOutcome`, `PushTarget`, `PwaManifestInvalidError`, `PwaNoOfflineFallbackError`, `PwaPushFailedError`, `PwaPushHostUnlistedError`, `PwaPushPayloadTooLargeError`, `PwaPushRejectedError`, `PwaPushSubscriptionInvalidError`, `PwaPushUnconfiguredError`, `PwaVapidKeyInvalidError`, `PwaVapidKeyMissingError`, `STRATEGY_NAMES`, `SYNC_TAG`, `SafeZone`, `SwScopeInvalidError`, `VAPID_TOKEN_TTL_SECONDS`, `VapidTokenInput`, `assertPushEndpoint`, `enabledCapabilities`, `encryptPushMessage`, `maskableSafeZone`, `pushEndpointProblem`, `pushHostAllowed`, `pushMessageCapacity`, `sendPushMessage`, `vapidAuthorization`.

## `@ultimat3/query`

Now on `./adapter`: `QueryClient`, `QueryClientOptions`.

No longer exported: `CursorValueUnsupportedError`, `DEFAULT_DOWNLOAD_TTL_MS`, `DownloadTokenProblem`, `MAX_DOWNLOAD_TTL_MS`, `MIN_DOWNLOAD_TTL_MS`, `MatcherUnsupportedError`, `QueryAuditSinkFailedError`, `QueryAuditSinkMissingError`, `QueryDeprecationInvalidError`, `QueryDownloadInvalidError`, `QueryDownloadOnlyError`, `QueryDownloadTokenExpiredError`, `QueryDownloadTokenInvalidError`, `QueryDuplicateError`, `QueryFacade`, `QueryForeignError`, `QueryInputUnencodableError`, `QueryMaxPageInvalidError`, `QueryNotPageableError`, `QueryPolicyMissingError`, `QuerySubscribesDriftError`, `QuerySubscribesInvalidError`, `QueryUnregisteredError`, `downloadClientFor`.

## `@ultimat3/realtime`

Now on `./adapter`: `TransportProtocolError`.

No longer exported: `ChannelWireFrame`, `CursorStaleError`, `FrameRateLimitError`, `LiveQueryRef`, `LiveQueryUnknownError`, `LiveRowUnidentifiedError`, `ProtocolVersionError`, `REALTIME_ERROR_CODES`, `RealtimeUninstalledError`, `RebaseConflictError`, `ReconnectReason`, `RecordPersister`, `RecordRejectedError`, `ReplicaIdentityError`, `ReplicationFailedError`, `ReplicationProtocolError`, `ReplicationSlotInvalidatedError`, `ReplicationSlotRecreatedError`, `ReplicationTlsError`, `RowWindows`, `ServerRenderLiveError`, `SyncUnconfiguredError`, `WindowReadTimeoutError`, `defaultReconnectBudget`, `makeCursor`, `persistedTypes`, `recordPersister`, `timeoutScheduler`.

## `@ultimat3/render`

Now on `./adapter`: `AssetResolver`.

No longer exported: `ASSET_EXTENSIONS`, `BudgetExceededError`, `CachedDocument`, `DEFAULT_ISLAND_HYDRATE`, `IslandNotHydratedError`, `IslandPropsInvalidError`, `NAVIGATION_CACHE_MAX_ENTRIES`, `NAVIGATION_CACHE_TTL_MS`, `NAVIGATION_MAX_HOPS`, `NAVIGATION_NO_STORE_REUSE_MS`, `NAVIGATION_PREFETCH_DELAY_MS`, `NAVIGATION_PROGRESS_DELAY_MS`, `PrerenderFailedError`, `RENDER_ERROR_CODES`, `RENDER_ERROR_TITLES`, `RouteFileInvalidError`, `RouteLoadFailedError`, `RouteLoadInvalidError`, `RouteMetaMissingError`, `RouteOfflineMissingError`, `RouteStatusInvalidError`, `SurfaceBoundaryError`, `ZONE_SCRIPT_MAX_BYTES`, `assertSurfaceBoundary`, `defaultHydrate`, `mergeHead`.

## `@ultimat3/schema`

Now on `./adapter`: `builtinProvider`, `resetSchemaProvider`, `schemaProvider`.

No longer exported: `JSON_MAX_DEPTH`, `SchemaRule`, `arraySchema`, `builtinT`, `discriminatedUnionSchema`, `enumSchema`, `nullableSchema`, `optionalSchema`, `refineSchema`, `unionSchema`.

## `@ultimat3/scraping`

Now on `./adapter`: `cdpAttachFailed`, `egressUnsupported`, `hostBlocked`, `notActionable`, `pageCrashed`, `profileLocked`, `scrapeTimeout`, `selectorMissing`.

No longer exported: `CDP_DRIVER`, `COLOR_SCHEMES`, `CdpRequestLike`, `DEFAULT_PDF_TIMEOUT_MS`, `DEFAULT_PROMPT_ANSWER_TTL_MS`, `DEFAULT_PROMPT_POLL_MS`, `FAKE_DRIVER`, `FAKE_PAGE_URL`, `FIXTURE_DRIVER`, `HtmlTargetInit`, `MarkupRequest`, `OfflineSessionInit`, `PDF_CONTENT_TYPE`, `RecordingLookup`, `RedirectHop`, `RobotsRules`, `SCRAPE_BORROWED_ERROR_CODES`, `SCRAPE_ERROR_TITLES`, `SESSION_SEAL_PURPOSE`, `ScrapeEventFields`, `ScrapeOwnedErrorCode`, `StepEvent`, `WedgeGuardInit`, `YieldCheck`, `authFailed`, `bodyTooLarge`, `browserRecord`, `cdpResolveFailed`, `downloadTimeout`, `egressInPayload`, `endpointLabel`, `fixtureMissing`, `fixtureStale`, `htmlTarget`, `httpRecordingSchema`, `httpRecordingsOf`, `isColorScheme`, `isRetryableScrapeError`, `keyInvalid`, `openOfflineSession`, `outputInvalid`, `pageRecordingSchema`, `parseHttpRecording`, `parseRecording`, `parseRobots`, `promptAnswerInvalid`, `promptTimedOut`, `recordedHttp`, `recordingsOf`, `recoverRefused`, `redirectLoop`, `robotsAllows`, `robotsDisallowed`, `runRecovery`, `secretExposed`, `yieldCollapsed`.

## `@ultimat3/seo`

Now on `./adapter`: `notImplementedDriver`.

No longer exported: `IMAGE_QUERY_KEYS`, `MIME_TYPES`, `SITEMAP_INDEX_MAX_FILES`, `canonicalMismatch`, `duplicateMeta`, `imageQueryInvalid`, `linkInvalid`, `metaTooLong`, `sitemapTooLarge`.

## `@ultimat3/storage`

Now on `./adapter`: `listFailed`, `pathUnsafe`, `putTooLarge`.

No longer exported: `DEFAULT_LIST_LIMIT`, `DEFAULT_SIGNED_URL_TTL_MS`, `MAX_PART_BYTES`, `MultipartUploadInput`, `RETENTION_MODES`, `SIGNED_URL_PARAMS`, `SIGNED_URL_VERSION`, `STORAGE_ERROR_CODES`, `STORAGE_ERROR_TITLES`, `STORAGE_SUBJECT_COLUMNS`, `assertGetOptions`, `contentTypeMatches`, `contentTypeMismatch`, `contentTypeNotAllowed`, `contentTypeUnrecognised`, `defaultSignedPut`, `diskUnknown`, `keyDirname`, `matchParts`, `multipartUnsupported`, `orgPrefix`, `partsInvalid`, `pendingPrefix`, `rangeUnsatisfiable`, `scanUnavailable`, `servedRange`, `signedUrlExpired`, `signedUrlRejected`, `signedUrlUnverifiable`, `signingSecretMissing`, `sniffContentType`, `uploadExtension`, `uploadFailed`, `uploadHeld`, `uploadInParts`, `uploadInfected`, `uploadUnknown`.

## `@ultimat3/testing`

No longer exported: `ALL_FIXTURE_NAMES`, `CASSETTE_ENV`, `CassetteEntry`, `CassetteFile`, `CassetteMissingError`, `CassetteRecordRefusedError`, `CassetteSecretError`, `CassetteUnusedError`, `DEFAULT_ISLAND_THEME`, `DEFAULT_ISLAND_VIEWPORT`, `DEFAULT_TEMPLATE`, `DRILL_DRAW_SEED`, `DRILL_SERVICE_ENV`, `DRIVER_FIXTURE_NEEDS`, `DatabaseSnapshot`, `DrillWriteCandidate`, `DriverFixtures`, `E2E_ERROR_TITLES`, `E2eErrorCode`, `E2eResolution`, `EffectPayload`, `EvaluablePage`, `FactoryInvalidError`, `FakeResizeObserverEntry`, `ISLAND_MOUNT_TIMEOUT_MS`, `ISLAND_STATES`, `ISLAND_THEMES`, `IslandFaultKind`, `IslandStatesFault`, `JOB_FAULT_KINDS`, `JobSimInvariantError`, `JobSimNondeterministicError`, `MARK_ATTRIBUTE`, `MatcherResult`, `ModuleEdge`, `OpenApiLike`, `PlanTableColumns`, `PlanVerdict`, `RecordRefusal`, `RegistrySample`, `ResizeRect`, `SeedGraphEntityUnknownError`, `SubjectEraseIncompleteError`, `TESTING_ERROR_CODES`, `TESTING_ERROR_TITLES`, `TestAdapterPortUnswappableError`, `TestExpectedInputInvalidError`, `TestMailExpectedError`, `TestPaceInvalidError`, `TestRunJobsExpectedError`, `TestScopeUninstalledError`, `TestStubTargetUnsupportedError`, `TestStubUnansweredError`, `UNBOUND_ID`, `UnusedEntry`, `captureProcessRegistries`, `clearFixtures`, `closureSource`, `databaseNameFor`, `driverFixtures`, `evaluateClosure`, `evaluateExpression`, `importSpecifiers`, `impureSpecifier`, `isIslandTheme`, `isNetworkSealed`, `isStateId`, `islandStatesFault`, `islandStatesImportFault`, `islandStatesName`, `judgePlan`, `leakBetween`, `markSelector`, `matchersInstalled`, `missingIslandFiles`, `moduleEdges`, `networkState`, `normalizeIslandName`, `planFindings`, `planRoot`, `registeredFixtures`, `resetLocatorMarks`, `restoreCapturedNetwork`, `restoreDatabase`, `restoreProcessRegistries`, `sampleRegistries`, `seedFor`, `seededUuid`, `selectionCall`, `selectionExpression`, `slugifyStateId`, `snapshotDatabase`, `testPace`, `testPush`, `throughFaultProxy`, `unlockSql`, `unmarkExpression`.

## `@ultimat3/time`

No longer exported: `TIME_ERROR_TITLES`, `WEEK`, `WeeklySlot`, `compareInstants`, `cronInvalid`, `cronNotDescribable`, `dstAmbiguous`, `dstNonexistent`, `durationInvalid`, `firedSince`, `formatIsoDate`, `fromEpochSeconds`, `instantInvalid`, `isAfter`, `isBefore`, `isInstant`, `isWeekend`, `nextLocalSlots`, `nextWeeklySlot`, `offsetLabel`, `subtractMs`, `timezoneInvalid`, `toIsoDateUtc`.

## `@ultimat3/ui`

No longer exported: `AccordionItem`, `AccordionSection`, `ArrowKeyElement`, `BOTTOM_NAV_MAX`, `BUTTON_VARIANTS`, `BarExtent`, `BoardColumn`, `BottomNavItem`, `BrandInput`, `ButtonVariant`, `CHART_DISTINCT_MIN`, `CHART_ROLES`, `CHORD_WINDOW_MS`, `COLOUR_VISIONS`, `CONFIRM_IDLE`, `COPIED_MS`, `CalendarBounds`, `CanDrop`, `ChartLegendItem`, `ChartReference`, `ChartRole`, `ChartTable`, `ChartTableRow`, `ClassValue`, `ColumnPriority`, `CommandPaletteController`, `CommandPaletteGroup`, `CommandPaletteState`, `CompiledHotkeys`, `ConfirmEvent`, `ConfirmState`, `ContainerSize`, `ContrastPair`, `DEBOUNCE_DEFAULT_MS`, `DataTableNarrow`, `DateRange`, `DateTimeView`, `DateTimeViewOptions`, `DeltaOptions`, `DescriptionItem`, `DonutSegment`, `DrawerRelease`, `DrawerSide`, `DrawerSnap`, `EDITABLE_SELECTOR`, `FOCUSABLE_SELECTOR`, `FONT_SLOTS`, `FieldPathSegment`, `FileCandidate`, `FileRejection`, `FileRejectionReason`, `FileSelection`, `FileSelectionLimits`, `FileTarget`, `FlatTreeNode`, `FontSlot`, `FormBindingOptions`, `FormErrors`, `FormState`, `FormStatus`, `FormTouch`, `GaugeThreshold`, `HEADING_LEVELS`, `HeadingLevel`, `HeadingTag`, `HeatCell`, `HeatShape`, `HotkeyAnswer`, `HotkeyHost`, `HotkeyKeyEvent`, `HotkeyRow`, `HotkeyState`, `ICON_TAGS`, `IDLE_FORM_STATE`, `IDLE_HOTKEY_STATE`, `IconElement`, `IconTag`, `ImageAspectRatio`, `ImageBox`, `ImageDimensions`, `ImageLoadingHints`, `ImageSources`, `ImageVariant`, `LIVE_INDICATOR_STATES`, `LIVE_REGION_LEVELS`, `LOG_VIEWER_LEVELS`, `LinkTarget`, `ListChange`, `ListLimit`, `ListUrlOptions`, `LiveIndicatorState`, `LiveRegionAttrs`, `LiveWindowOptions`, `LoadMoreInput`, `LoadMoreState`, `LogViewerLevel`, `MENU_ITEM_SELECTOR`, `MarkdownBlock`, `MarkdownInline`, `MarkdownListItem`, `MoneyFormatter`, `MoneyViewOptions`, `NO_FORM_ERRORS`, `NO_FORM_TOUCH`, `NavListEntry`, `NavListGroup`, `NavListLink`, `NiceScale`, `NiceTicksOptions`, `PULL_IDLE`, `PULL_MAX`, `PULL_THRESHOLD`, `PaletteKeyAction`, `Politeness`, `PullController`, `PullEvent`, `PullState`, `RadioOption`, `RankableOption`, `RankedOptions`, `RelativeTimeOptions`, `ReserveBox`, `ResolvedImage`, `RovingItem`, `RovingOptions`, `RovingOrientation`, `SHADOW_NAMES`, `SIZES`, `ScrollAnchor`, `SeriesStyle`, `Setter`, `ShellIds`, `ShellLandmark`, `ShellSlots`, `SolidContext`, `SortFields`, `SpaceStep`, `SpanPosition`, `SparkPoint`, `StatGoodWhen`, `StatMood`, `StatTrend`, `StepOptions`, `StepState`, `StepperModel`, `StepperStep`, `TAB_SELECTOR`, `TEXT_TONES`, `THEME_PRESETS`, `THEME_PRESET_NAMES`, `TOKEN_KINDS`, `TabItem`, `TabLinkItem`, `TableAlign`, `TextSize`, `TextTone`, `TextWeight`, `ThemeChoice`, `ThemePreset`, `ThemePresetName`, `TimeInput`, `TimeRangeChange`, `TimeRangePreset`, `TimeRangeUrlOptions`, `TimelineGroup`, `TimelineItem`, `ToastInput`, `ToastItem`, `ToastPlacement`, `ToastQueue`, `TokenKind`, `TokenRule`, `TreeMove`, `UI_DEFAULT_CURRENCY`, `UI_DEFAULT_LOCALE`, `UI_DEFAULT_TIME_ZONE`, `UiContextValue`, `UseCommandPaletteOptions`, `VIRTUAL_LIST_ESTIMATE`, `VIRTUAL_LIST_OVERSCAN`, `VisibleRange`, `Weekday`, `anchorAt`, `anchoredScrollTop`, `ariaBool`, `assertColorRole`, `bottomNavItems`, `breakpointTokens`, `browserToastEnv`, `closestChartPair`, `colourDistance`, `compileHotkeys`, `confirmLabelOf`, `confirmStep`, `conflictingFieldNameError`, `dayLabel`, `defaultUiContext`, `dragOffset`, `durationTokens`, `easingTokens`, `flattenTree`, `focusableWithin`, `fontSizeTokens`, `fontWeightTokens`, `fromLocalDateTime`, `groupItems`, `handlesOwnArrowKeys`, `hasSolidRuntime`, `hotkeyKeycaps`, `invalidBrandTokenError`, `invalidFieldPathError`, `invalidGlyphError`, `invalidThemeError`, `isFormDirty`, `isTheme`, `lineHeightTokens`, `markDirty`, `markTouched`, `meetsContrast`, `monthGrid`, `monthLabel`, `nextHeadingLevel`, `orderedRange`, `osTheme`, `pickRange`, `pullController`, `pullDistance`, `pullStep`, `radiusTokens`, `relativeLuminance`, `releaseSnap`, `reservedRatio`, `rovingDay`, `rowOffsets`, `seriesStyle`, `shadowTokens`, `simulateColourVision`, `sourceSetsFor`, `spaceTokens`, `spanPosition`, `stepperModel`, `storedTheme`, `strokeTokens`, `tabStopIndex`, `timelineGroups`, `toIsoInstant`, `toLocalDateTime`, `toMoney`, `touchTokens`, `treeAncestors`, `treeMove`, `treeTypeahead`, `uiContext`, `unknownTokenError`, `useHotkeyRows`, `visibleRange`, `visibleTreeIds`, `weekStartOf`, `weekdayLabels`, `zTokens`.
