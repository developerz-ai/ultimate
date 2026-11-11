// `quotaAlertSms`, the quota slice's notifier — one primitive per file, the layout `x g` writes.
//
// `notifier()` is a job factory and `smsChannel()` a reference channel over the app's
// `smsTransport` port: the text is a catalog KEY rendered in each owner's locale, with one provider
// idempotency key per (alert, owner). A replay after the delivery ledger recorded a send sends
// nothing; a crash between `send` and that ledger write sends again unless the transport honours
// `idempotencyKey` — Twilio's API does not, so with it an owner can get the text twice.
// Postly has no SMS vendor: development and test use notify's memory transport, and a deploy
// names one as `smsTransport:` in `apps/web/runtime.ts` — until then a send there is
// `X_NOTIFY_SMS_TRANSPORT_MISSING`, refused loudly rather than swallowed.
//
// `t` comes from @ultimat3/notify, not @ultimat3/schema: a notifier file imports one package.

import { orgId as toOrgId } from '@postly/domain';
// The text renders HERE, on the worker, in the owner's locale: importing the app catalog is what
// registers it (`comment-posted.ts` says the same of its push).
import '@postly/i18n';
import { type Infer, notifier, smsChannel, t } from '@ultimat3/notify';

const QuotaAlertSms = t.object({
  orgId: t.uuid,
  meter: t.string,
  used: t.number.int(),
  limit: t.number.int(),
  periodStart: t.string,
});

type QuotaAlertSms = Infer<typeof QuotaAlertSms>;

/** The org's owners who gave a phone hear that the day's drafts are nearly spent. */
export const quotaAlertSms = notifier({
  name: 'quota.alert.sms',
  input: QuotaAlertSms,
  tenant: (params) => params.orgId,
  key: (params) => `${params.meter}:${params.orgId}:${params.periodStart}`,
  // A NAMED-org read: a served worker's actor carries only the org this job declared.
  recipients: async ({ input, ctx }) =>
    (await ctx.orgs.textableOwners(toOrgId(input.orgId))).map((owner) => ({
      id: owner.id,
      to: owner.phone ?? undefined,
      locale: owner.locale,
      tz: owner.tz,
    })),
  deliver: [
    {
      channel: smsChannel<QuotaAlertSms>({
        message: ({ event }) => ({
          key: 'sms.quotaAlert',
          params: { used: event.params.used, limit: event.params.limit },
        }),
      }),
    },
  ],
});
