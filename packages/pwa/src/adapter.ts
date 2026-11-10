// `@ultimat3/pwa/adapter`: the `pushSubscriptionStore` port (`ADAPTER_PORTS`) as an adapter author
// needs it — `PushSubscriptionStore` and the record it keeps. A store raises no error of its own (a
// refused write is its driver's). No installer: the boot READS `runtime.ts`'s
// `pushSubscriptionStore` while `pwa.vapid` is set (`@ultimat3/cli`'s `runtime-push.ts`). Types only.

export type { PushSubscriptionKeys, PushSubscriptionRecord } from './push';
export type { PushSubscriptionStore } from './push-store';
