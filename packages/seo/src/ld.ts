// Typed JSON-LD builders. Required schema.org fields are required in the input
// type, so a missing `datePublished` is a compile error rather than a Search
// Console warning three weeks later. Runtime checks catch empty strings that the
// type system cannot (a value read from a CMS).

import { ldInvalid } from './errors';

export type JsonLd = Readonly<Record<string, unknown>>;

export const LD_CONTEXT = 'https://schema.org';

function required(type: string, field: string, value: string, hint: string): string {
  if (value.trim() === '') throw ldInvalid(type, field, hint);
  return value;
}

function node(type: string, body: Readonly<Record<string, unknown>>): JsonLd {
  const out: Record<string, unknown> = { '@context': LD_CONTEXT, '@type': type };
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

// --- inputs ------------------------------------------------------------------

export interface PersonInput {
  name: string;
  url?: string;
  image?: string;
  jobTitle?: string;
  sameAs?: readonly string[];
}

export interface OrganizationInput {
  name: string;
  url: string;
  logo?: string;
  sameAs?: readonly string[];
  description?: string;
}

/** Discriminated so an Organization author is never mis-rendered as a Person. */
export interface ArticleAuthorPerson extends PersonInput {
  type?: 'Person';
}

export interface ArticleAuthorOrganization extends OrganizationInput {
  type: 'Organization';
}

export type ArticleAuthor = ArticleAuthorPerson | ArticleAuthorOrganization;

export interface ArticleInput {
  headline: string;
  /** ISO 8601. Required by schema.org for Article rich results. */
  datePublished: string;
  author: ArticleAuthor;
  dateModified?: string;
  description?: string;
  image?: string | readonly string[];
  url?: string;
  publisher?: OrganizationInput;
  articleSection?: string;
  keywords?: readonly string[];
}

export interface OfferInput {
  /** Decimal string, never a float, e.g. `'19.99'`. */
  price: string;
  priceCurrency: string;
  availability?: 'InStock' | 'OutOfStock' | 'PreOrder' | 'BackOrder';
  url?: string;
  priceValidUntil?: string;
}

export interface ProductInput {
  name: string;
  offers: OfferInput;
  image?: string | readonly string[];
  description?: string;
  sku?: string;
  brand?: string;
  aggregateRating?: { ratingValue: string; reviewCount: number };
}

export interface WebSiteInput {
  name: string;
  url: string;
  /** Enables the sitelinks search box. `{search_term_string}` is substituted. */
  searchUrlTemplate?: string;
  inLanguage?: string;
  publisher?: OrganizationInput;
}

export interface BreadcrumbInput {
  items: ReadonlyArray<{ name: string; url: string }>;
}

export interface FaqInput {
  questions: ReadonlyArray<{ question: string; answer: string }>;
}

export interface EventInput {
  name: string;
  /** ISO 8601. Required. */
  startDate: string;
  /** A venue name or a URL for an online event. Required. */
  location: string;
  endDate?: string;
  description?: string;
  url?: string;
  eventAttendanceMode?: 'Offline' | 'Online' | 'Mixed';
  offers?: OfferInput;
}

export interface SoftwareApplicationInput {
  name: string;
  /** e.g. `DeveloperApplication`. Required for the app rich result. */
  applicationCategory: string;
  operatingSystem: string;
  offers?: OfferInput;
  aggregateRating?: { ratingValue: string; reviewCount: number };
  url?: string;
}

// --- builders ----------------------------------------------------------------

function personOrOrg(input: ArticleAuthor): JsonLd {
  return input.type === 'Organization' ? Organization(input) : Person(input);
}

function offer(input: OfferInput): JsonLd {
  required('Offer', 'price', input.price, 'a decimal string such as "19.99"');
  required('Offer', 'priceCurrency', input.priceCurrency, 'an ISO-4217 code such as "USD"');
  return node('Offer', {
    price: input.price,
    priceCurrency: input.priceCurrency,
    availability:
      input.availability === undefined ? undefined : `https://schema.org/${input.availability}`,
    url: input.url,
    priceValidUntil: input.priceValidUntil,
  });
}

export function Person(input: PersonInput): JsonLd {
  required('Person', 'name', input.name, 'the person as they should be credited');
  return node('Person', {
    name: input.name,
    url: input.url,
    image: input.image,
    jobTitle: input.jobTitle,
    sameAs: input.sameAs,
  });
}

export function Organization(input: OrganizationInput): JsonLd {
  required('Organization', 'name', input.name, 'the legal or trading name');
  required('Organization', 'url', input.url, 'the canonical homepage URL');
  return node('Organization', {
    name: input.name,
    url: input.url,
    logo: input.logo,
    sameAs: input.sameAs,
    description: input.description,
  });
}

export function Article(input: ArticleInput): JsonLd {
  required('Article', 'headline', input.headline, 'the visible article headline');
  required('Article', 'datePublished', input.datePublished, 'an ISO 8601 date');
  return node('Article', {
    headline: input.headline,
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: personOrOrg(input.author),
    description: input.description,
    image: input.image,
    url: input.url,
    publisher: input.publisher === undefined ? undefined : Organization(input.publisher),
    articleSection: input.articleSection,
    keywords: input.keywords,
  });
}

export function Product(input: ProductInput): JsonLd {
  required('Product', 'name', input.name, 'the product name shown on the page');
  return node('Product', {
    name: input.name,
    offers: offer(input.offers),
    image: input.image,
    description: input.description,
    sku: input.sku,
    brand: input.brand === undefined ? undefined : { '@type': 'Brand', name: input.brand },
    aggregateRating:
      input.aggregateRating === undefined
        ? undefined
        : { '@type': 'AggregateRating', ...input.aggregateRating },
  });
}

export function WebSite(input: WebSiteInput): JsonLd {
  required('WebSite', 'name', input.name, 'the site name');
  required('WebSite', 'url', input.url, 'the canonical homepage URL');
  return node('WebSite', {
    name: input.name,
    url: input.url,
    inLanguage: input.inLanguage,
    publisher: input.publisher === undefined ? undefined : Organization(input.publisher),
    potentialAction:
      input.searchUrlTemplate === undefined
        ? undefined
        : {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: input.searchUrlTemplate,
            },
            'query-input': 'required name=search_term_string',
          },
  });
}

export function BreadcrumbList(input: BreadcrumbInput): JsonLd {
  if (input.items.length === 0) {
    throw ldInvalid('BreadcrumbList', 'items', 'at least one crumb');
  }
  return node('BreadcrumbList', {
    itemListElement: input.items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: required('BreadcrumbList', 'items[].name', item.name, 'the crumb label'),
      item: required('BreadcrumbList', 'items[].url', item.url, 'an absolute URL'),
    })),
  });
}

export function FAQPage(input: FaqInput): JsonLd {
  if (input.questions.length === 0) {
    throw ldInvalid('FAQPage', 'questions', 'at least one question/answer pair');
  }
  return node('FAQPage', {
    mainEntity: input.questions.map((entry) => ({
      '@type': 'Question',
      name: required('FAQPage', 'questions[].question', entry.question, 'the question text'),
      acceptedAnswer: {
        '@type': 'Answer',
        text: required('FAQPage', 'questions[].answer', entry.answer, 'the answer text'),
      },
    })),
  });
}

export function Event(input: EventInput): JsonLd {
  required('Event', 'name', input.name, 'the event name');
  required('Event', 'startDate', input.startDate, 'an ISO 8601 date-time');
  required('Event', 'location', input.location, 'a venue name or an online URL');
  const online = /^https?:\/\//.test(input.location);
  return node('Event', {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    description: input.description,
    url: input.url,
    eventAttendanceMode: `https://schema.org/${input.eventAttendanceMode ?? (online ? 'Online' : 'Offline')}EventAttendanceMode`,
    location: online
      ? { '@type': 'VirtualLocation', url: input.location }
      : { '@type': 'Place', name: input.location },
    offers: input.offers === undefined ? undefined : offer(input.offers),
  });
}

export function SoftwareApplication(input: SoftwareApplicationInput): JsonLd {
  required('SoftwareApplication', 'name', input.name, 'the application name');
  required(
    'SoftwareApplication',
    'applicationCategory',
    input.applicationCategory,
    'a schema.org application category',
  );
  required(
    'SoftwareApplication',
    'operatingSystem',
    input.operatingSystem,
    'the supported OS list, e.g. "Linux, macOS"',
  );
  return node('SoftwareApplication', {
    name: input.name,
    applicationCategory: input.applicationCategory,
    operatingSystem: input.operatingSystem,
    url: input.url,
    offers: input.offers === undefined ? undefined : offer(input.offers),
    aggregateRating:
      input.aggregateRating === undefined
        ? undefined
        : { '@type': 'AggregateRating', ...input.aggregateRating },
  });
}

/** The namespace routes use: `meta: () => ({ ld: [ld.Article(post)] })`. */
export const ld = {
  Article,
  BreadcrumbList,
  Event,
  FAQPage,
  Organization,
  Person,
  Product,
  SoftwareApplication,
  WebSite,
} as const;
