// Single responsibility: what the inbound tests replay — a real-shaped multipart message (text,
// HTML, a PDF and a disallowed script), the SES `Received` notification around it, a Resend
// `email.received` body, and a `WebhookInbound` over any bytes. Test-only.

import type { WebhookInbound } from './inbound-types';

/** `%PDF-` opens it, so storage's sniff agrees with the declared type. */
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%fixture\n');

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export const MULTIPART = `Received: from mx.sender.test by inbound-smtp.test
Received: from laptop by mx.sender.test
From: Ada Lovelace <ada@sender.test>
To: support@app.test
Cc: "Babbage, Charles" <charles@sender.test>
Subject: =?UTF-8?Q?Invoice_=E2=80=94_March?=
Date: Tue, 06 Oct 2026 12:00:00 +0000
Message-ID: <m-1@sender.test>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed-1"

--mixed-1
Content-Type: multipart/alternative; boundary="alt-1"

--alt-1
Content-Type: text/plain; charset=utf-8

Please find the invoice attached.
--alt-1
Content-Type: text/html; charset=utf-8

<p>Please find the invoice attached.</p>
--alt-1--
--mixed-1
Content-Type: application/pdf; name="invoice.pdf"
Content-Disposition: attachment; filename="invoice.pdf"
Content-Transfer-Encoding: base64

${b64(PDF_BYTES)}
--mixed-1
Content-Type: text/html; name="run-me.html"
Content-Disposition: attachment; filename="run-me.html"

<script>alert(1)</script>
--mixed-1--
`.replace(/\n/g, '\r\n');

export const SES_MESSAGE_ID = 'o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1';

/** The SNS `Message` a receipt rule's SNS action publishes (AWS's documented shape). */
export function sesReceived(content: string | undefined, encoding: 'BASE64' | 'UTF8' = 'BASE64') {
  return {
    notificationType: 'Received',
    mail: {
      timestamp: '2026-10-06T12:00:00.000Z',
      source: 'ada@sender.test',
      messageId: SES_MESSAGE_ID,
      destination: ['support@app.test'],
    },
    receipt: {
      timestamp: '2026-10-06T12:00:00.000Z',
      recipients: ['support@app.test'],
      spamVerdict: { status: 'PASS' },
      virusVerdict: { status: 'PASS' },
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'GRAY' },
      dmarcVerdict: { status: 'PASS' },
      action: { type: 'SNS', topicArn: 'arn:aws:sns:us-west-2:123456789012:ses-events', encoding },
    },
    ...(content === undefined ? {} : { content }),
  };
}

export const base64Of = (text: string): string => b64(new TextEncoder().encode(text));

export const RESEND_EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';

/** Resend's `email.received` webhook: metadata only, as Resend documents it. */
export const RESEND_RECEIVED = {
  type: 'email.received',
  created_at: '2026-10-06T12:00:00.000Z',
  data: {
    email_id: RESEND_EMAIL_ID,
    created_at: '2026-10-06T12:00:00.000Z',
    from: 'Ada Lovelace <ada@sender.test>',
    to: ['support@app.test'],
    cc: [],
    bcc: [],
    received_for: ['support@app.test'],
    message_id: '<m-1@sender.test>',
    subject: 'Invoice — March',
    attachments: [{ id: 'a1', filename: 'invoice.pdf', content_type: 'application/pdf' }],
  },
};

export function inboundOf(
  body: string,
  headers: Readonly<Record<string, string>> = {},
): WebhookInbound {
  const bytes = new TextEncoder().encode(body);
  const url = new URL('https://app.test/hooks/mail');
  return {
    bytes,
    headers: new Headers(headers),
    params: {},
    url,
    request: () => new Request(url, { method: 'POST', headers, body: bytes }),
  };
}
