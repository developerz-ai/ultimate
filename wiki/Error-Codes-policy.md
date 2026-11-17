# Error codes: `@ultimat3/policy`

Part of [Error codes](Error-Codes): every code `@ultimat3/policy` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_FORBIDDEN` | policy denied this actor | the actor exists but the policy said no. A remote caller — a production problem document, an app's MCP tool result — is given the error's `callerFix` instead: ask the account owner or an administrator for the permission (`As of 22.10`) | `x policy explain <path> --json` |
| `X_PERMISSION_UNKNOWN` | permission string is not in the permission set | typo, or a permission never declared | `can('<nearest declared>')` when it is a typo — the fix names the nearest — else `definePermissions(['<resource>:<verb>'])`: a second call merges |
| `X_POLICY_CLAUSE_EMPTY` | a policy combinator was built with no clauses | `and()` answered **allowed** and `admitsAnonymous(and())` agreed, so `policy: and(...caps.map(can))` over a list that filtered to empty admitted an anonymous caller on all four surfaces — and because `meta.auth` derives from `admitsAnonymous`, http did not 401 first. The label rendered as `and()`, so there was no diagnostic. `or()` fails closed but denies with `no clause allowed this actor`, a reason naming no clause. Both are refused where they are written, the `allowHosts: []` precedent | `allow('public')` is the spelling for "no clauses required"; `deny('<reason>')` is the one that carries a reason |
| `X_POLICY_MISSING` | an action was declared without a policy | a new action shipped with no `policy:` | `policy: can('<resource>:<verb>')` — or `policy: allow('public')` to say so explicitly |
| `X_POLICY_SURFACE_UNKNOWN` | enforce() was handed a surface no adapter answers to | `enforce(surface, policy, args)` called with a value outside `'http' \| 'live' \| 'job' \| 'mcp'` — a config-driven table, a surface name off the wire, or a JS host, none of which the type reached. Refused rather than dispatched because the adapter table is an object literal and so inherits `Object.prototype`: `adapters['valueOf']` answered a FUNCTION, `enforce('valueOf', …)` called it with the table as its receiver, and the truthy return was the adapter table typed as a `SurfaceDenial` — an authz dispatch that failed CLOSED with a denial carrying no code and no reason | `enforce('http', policy, args)` — the surface is one of `http`, `live`, `job`, `mcp` — or add the adapter for the new surface in `packages/policy/src/surfaces.ts`, the one place a fifth may be declared |
| `X_ROLE_REDEFINED` | two modules define the same role differently | one role name declared twice with different grants — a merged feature branch, or a role copied into a second module. Whichever module imported last would otherwise decide what the role can do, and the losing definition is still on disk for the next reader to trust. Both declaration sites are named, because which two is the only thing the author does not already know | `x policy list --json` — then keep ONE definition of the role `cause` names: rename the second, or fold its grants into the first |

## Notes

### Policy and authz

A denial is `X_FORBIDDEN`, above — `@ultimat3/policy` owns it and every surface adapter throws it, so there is one code for "the policy said no" wherever it was decided.
