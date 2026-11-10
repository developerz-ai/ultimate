// Single responsibility: what a VERIFIED assertion says, checked — issuer, the bearer subject
// confirmation (recipient, InResponseTo, its window), the conditions (window, audience) — and read
// out as one `SamlAssertion`. It only ever sees the node whose signature `saml-response.ts` just
// verified: it is handed that node, never a document to search.

import { attribute, BEARER, childElements, NAMEID_TRANSIENT, SAML_NS, textOf } from './saml-dom';
import type { SamlCheck } from './saml-errors';
import type { XmlElement } from './saml-xml';

export interface SamlAssertion {
  readonly id: string;
  readonly issuer: string;
  readonly nameId: string;
  readonly nameIdFormat: string | null;
  /** Every Attribute by `Name`, values in document order. */
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  /** The last instant this assertion is acceptable: the earlier of the two NotOnOrAfter. */
  readonly notOnOrAfter: Date;
  /** `SessionNotOnOrAfter`, when the IdP bounds the session. */
  readonly sessionNotOnOrAfter: Date | null;
  readonly sessionIndex: string | null;
}

export interface AssertionExpectations {
  readonly issuer: string;
  readonly audience: string;
  readonly recipient: string;
  readonly requestId: string;
  readonly now: Date;
  readonly skewMs: number;
}

export class AssertionRefusal {
  constructor(
    readonly check: SamlCheck,
    readonly detail: string,
  ) {}
}
const refuse = (check: SamlCheck, detail: string): never => {
  throw new AssertionRefusal(check, detail);
};

/** xs:dateTime, which SAML requires in UTC; anything unparseable is absent-and-wrong. */
const instant = (value: string | undefined): Date | null => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const one = (parent: XmlElement, local: string, check: SamlCheck): XmlElement => {
  const found = childElements(parent, SAML_NS, local);
  const first = found[0];
  return found.length === 1 && first !== undefined
    ? first
    : refuse(check, `expected one saml:${local}`);
};

const leaf = (element: XmlElement, check: SamlCheck): string =>
  textOf(element) ?? refuse(check, `saml:${element.local} holds an element`);

function window(element: XmlElement, expect: AssertionExpectations, required: boolean): Date {
  const now = expect.now.getTime();
  const notBefore = attribute(element, 'NotBefore');
  if (notBefore !== undefined) {
    const at = instant(notBefore) ?? refuse('not-before', 'NotBefore is not a UTC instant');
    if (at.getTime() - expect.skewMs > now)
      refuse('not-before', `${element.local} is not yet valid`);
  }
  const raw = attribute(element, 'NotOnOrAfter');
  if (raw === undefined && !required) return new Date(Number.POSITIVE_INFINITY);
  const end = instant(raw) ?? refuse('expired', `${element.local} has no UTC NotOnOrAfter`);
  if (end.getTime() + expect.skewMs <= now) refuse('expired', `${element.local} has expired`);
  return end;
}

/** At least one bearer confirmation must hold — SAML Profiles §4.1.4.2. */
function confirmation(subject: XmlElement, expect: AssertionExpectations): Date {
  let last: AssertionRefusal = new AssertionRefusal('subject', 'no bearer SubjectConfirmation');
  for (const confirmation of childElements(subject, SAML_NS, 'SubjectConfirmation')) {
    if (attribute(confirmation, 'Method') !== BEARER) continue;
    try {
      const data = one(confirmation, 'SubjectConfirmationData', 'subject');
      if (attribute(data, 'Recipient') !== expect.recipient) {
        refuse('recipient', 'the Recipient is not this ACS URL');
      }
      if (attribute(data, 'InResponseTo') !== expect.requestId) {
        refuse('in-response-to', 'the confirmation answers another request');
      }
      return window(data, expect, true);
    } catch (error) {
      if (!(error instanceof AssertionRefusal)) throw error;
      last = error;
    }
  }
  throw last;
}

function conditions(assertion: XmlElement, expect: AssertionExpectations): Date {
  const element = one(assertion, 'Conditions', 'audience');
  const end = window(element, expect, false);
  const restrictions = childElements(element, SAML_NS, 'AudienceRestriction');
  if (restrictions.length === 0) refuse('audience', 'the assertion names no audience');
  for (const restriction of restrictions) {
    const audiences = childElements(restriction, SAML_NS, 'Audience').map((a) =>
      leaf(a, 'audience'),
    );
    if (!audiences.includes(expect.audience)) refuse('audience', 'this SP is not an audience');
  }
  return end;
}

function attributes(assertion: XmlElement): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  for (const statement of childElements(assertion, SAML_NS, 'AttributeStatement')) {
    for (const item of childElements(statement, SAML_NS, 'Attribute')) {
      const name = attribute(item, 'Name');
      if (name === undefined) continue;
      const values = childElements(item, SAML_NS, 'AttributeValue').map((v) => leaf(v, 'subject'));
      out[name] = [...(out[name] ?? []), ...values];
    }
  }
  return out;
}

/** Check and read. Throws `AssertionRefusal`, which the caller turns into the coded error. */
export function readAssertion(assertion: XmlElement, expect: AssertionExpectations): SamlAssertion {
  const issuer = leaf(one(assertion, 'Issuer', 'issuer'), 'issuer');
  if (issuer !== expect.issuer)
    refuse('issuer', 'the assertion Issuer is not the metadata entityID');
  const subject = one(assertion, 'Subject', 'subject');
  const nameIdElement = one(subject, 'NameID', 'subject');
  const nameId = leaf(nameIdElement, 'subject').trim();
  const nameIdFormat = attribute(nameIdElement, 'Format') ?? null;
  if (nameId === '') refuse('subject', 'the NameID is empty');
  // A transient NameID is a new id per login: linked by it, every sign-in is a stranger.
  if (nameIdFormat === NAMEID_TRANSIENT) refuse('subject', 'the NameID is transient');
  const confirmed = confirmation(subject, expect);
  const conditioned = conditions(assertion, expect);
  const authn = childElements(assertion, SAML_NS, 'AuthnStatement');
  const statement = authn[0] ?? refuse('structure', 'the assertion carries no AuthnStatement');
  const session = attribute(statement, 'SessionNotOnOrAfter');
  return {
    id: attribute(assertion, 'ID') ?? '',
    issuer,
    nameId,
    nameIdFormat,
    attributes: attributes(assertion),
    notOnOrAfter: new Date(Math.min(confirmed.getTime(), conditioned.getTime())),
    sessionNotOnOrAfter:
      session === undefined
        ? null
        : (instant(session) ?? refuse('expired', 'bad SessionNotOnOrAfter')),
    sessionIndex: attribute(statement, 'SessionIndex') ?? null,
  };
}
