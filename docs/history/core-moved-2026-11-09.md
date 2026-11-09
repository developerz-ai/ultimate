# @ultimat3/core — rows moved out of CLAUDE.md (2026-11-09)

Moved whole when plan 101 slice 21 added `ADAPTER_PORTS`, `SleepClock` and `./adapter` to `packages/core/CLAUDE.md`, which sits at its 24 KB ceiling. The row is unchanged; CLAUDE.md keeps a one-line pointer here.

| Need | Owner | Rule |
|---|---|---|
| a stream-declaring action, read in the browser | `client-stream.ts` | `clientStream`: `POST` with `accept: text/event-stream` through `client-dispatch.ts`'s `dispatchStream` (the ONE browser `fetch`; body handed back unread), never `EventSource` (cannot POST, skips the credentials rule); `clientTransport`'s credentials, headers, caller's signal, session fence and problem decode; a `chunk` frame yields, `done` returns, `error` throws its problem at its own status. A JSON answer is `clientTransport`'s `settleAnswer` (envelope, records, dates), so `stream()` and `call()` agree. Never retried |
