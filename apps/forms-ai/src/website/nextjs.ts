import {
  DEFAULT_DOCUMENT_ROUTE,
  ENV_API_URL,
  ENV_WEBSITE_KEY,
  LINK_MINUTES,
  SEARCH_LIMIT,
} from './contract.js';

/**
 * The shared PDF pages for a company's Next.js website (`get_website_example`):
 * a server-only client for Integr8, the search page (one box, a list of
 * matches) with its Server Action, and the document page that every shared
 * link and new QR code opens (`/documents/<code>`), in English and Arabic.
 *
 * The code follows docs/documents/WEBSITE-LOOKUP.md: the key is read only on
 * the server, the visitor sees one "not found" whatever went wrong, the
 * five-minute links are used at once and never stored. `nextjs.test.ts`
 * compiles every variant and runs `check_website_integration` over it, so
 * the example always passes the program's own check.
 */

export type PageLanguage = 'en' | 'ar' | 'both';

export interface NextExampleOptions {
  /** The search page's folder under app/, e.g. "certificates" or "[locale]/certificates". */
  route?: string | undefined;
  /**
   * The document page's folder under app/ (its `[code]` folder goes inside),
   * "documents" by default: it must match the document link address Integr8
   * set for the company (`https://<site>/documents/{code}`).
   */
  documentRoute?: string | undefined;
  /** The project keeps its app folder in `src/`. */
  srcDir?: boolean | undefined;
  /** Which language the pages show; "both" reads `?lang=ar`. */
  language?: PageLanguage | undefined;
}

export interface GeneratedFile {
  path: string;
  purpose: string;
  content: string;
}

export const ROUTE_PATTERN =
  /^(?:[a-z0-9-]+|\[[a-zA-Z]+\]|\([a-z0-9-]+\))(?:\/(?:[a-z0-9-]+|\[[a-zA-Z]+\]|\([a-z0-9-]+\)))*$/u;

function clientFile(): string {
  return `import 'server-only';

/**
 * Integr8 Plus: the company's shared PDF documents, for its own website.
 * Server only: the website key never leaves this server. See the
 * "Connecting a company's website to Integr8" guide.
 */

export interface Integr8DocumentField {
  key: string;
  label: { en?: string; ar?: string };
  value: string;
}

export interface Integr8Document {
  title: string;
  formTitle: string;
  createdAt: string;
  pageCount: number | null;
  link: string | null;
  code: string;
  viewUrl: string;
  downloadUrl: string;
  expiresAt: string;
  fields: Integr8DocumentField[];
}

export type SearchOutcome =
  | { kind: 'found'; documents: Integr8Document[] }
  | { kind: 'not_found' }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

export type DocumentOutcome =
  | { kind: 'found'; document: Integr8Document }
  | { kind: 'not_found' }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

const LOOKUP_PATH = '/v1/website/documents/lookup';
const BY_CODE_PATH = '/v1/website/documents/by-code/';
/** A document link's code: 22 URL-safe characters. Anything else is not one. */
const CODE = /^[A-Za-z0-9_-]{22}$/;

async function ask(path: string, init: { method: 'GET' | 'POST'; body?: string }) {
  const apiUrl = process.env.${ENV_API_URL};
  const key = process.env.${ENV_WEBSITE_KEY};
  if (!apiUrl || !key) {
    console.error('Integr8: ${ENV_API_URL} or ${ENV_WEBSITE_KEY} is not set.');
    return undefined;
  }
  try {
    return await fetch(apiUrl.replace(/\\/+$/, '') + path, {
      method: init.method,
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'x-client-app': 'company-website',
      },
      body: init.body,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error('Integr8: no answer', error);
    return undefined;
  }
}

/** Every shared document whose reference or searchable field is exactly what the visitor typed. */
export async function searchDocuments(q: string): Promise<SearchOutcome> {
  const response = await ask(LOOKUP_PATH, { method: 'POST', body: JSON.stringify({ q }) });
  if (response === undefined) {
    return { kind: 'unavailable' };
  }
  if (response.status === 429) {
    return { kind: 'busy' };
  }
  if (!response.ok) {
    // 401: the key is wrong, disabled or revoked. 403: a switch is off.
    // 422: this code sent a wrong body. Logged here, never shown to visitors.
    console.error('Integr8 search refused', response.status, await response.text());
    return { kind: 'unavailable' };
  }
  const body = (await response.json()) as { found: boolean; documents: Integr8Document[] };
  return body.found && body.documents.length > 0
    ? { kind: 'found', documents: body.documents }
    : { kind: 'not_found' };
}

/** The document a shared link or QR code opens, by the code in the page's address. */
export async function documentByCode(code: string): Promise<DocumentOutcome> {
  if (!CODE.test(code)) {
    return { kind: 'not_found' };
  }
  const response = await ask(BY_CODE_PATH + encodeURIComponent(code), { method: 'GET' });
  if (response === undefined) {
    return { kind: 'unavailable' };
  }
  if (response.status === 429) {
    return { kind: 'busy' };
  }
  if (!response.ok) {
    console.error('Integr8 document refused', response.status, await response.text());
    return { kind: 'unavailable' };
  }
  const body = (await response.json()) as { found: boolean; document: Integr8Document | null };
  return body.found && body.document !== null
    ? { kind: 'found', document: body.document }
    : { kind: 'not_found' };
}
`;
}

function actionsFile(): string {
  return `'use server';

import { searchDocuments } from '@/lib/integr8';

/** One match, as the page shows it. The five-minute links go straight to the visitor and are never stored. */
export interface FoundDocument {
  title: string;
  formTitle: string;
  createdAt: string;
  pageCount: number | null;
  link: string | null;
  viewUrl: string;
  downloadUrl: string;
}

export interface SearchState {
  status: 'idle' | 'found' | 'not_found' | 'busy' | 'missing';
  documents?: FoundDocument[];
}

export async function searchDocument(_previous: SearchState, form: FormData): Promise<SearchState> {
  const q = String(form.get('q') ?? '').trim();
  if (q === '') {
    return { status: 'missing' };
  }
  if (q.length > 500) {
    return { status: 'not_found' };
  }
  const outcome = await searchDocuments(q);
  switch (outcome.kind) {
    case 'found':
      return {
        status: 'found',
        documents: outcome.documents.map(
          ({ title, formTitle, createdAt, pageCount, link, viewUrl, downloadUrl }) => ({
            title,
            formTitle,
            createdAt,
            pageCount,
            link,
            viewUrl,
            downloadUrl,
          }),
        ),
      };
    case 'busy':
      return { status: 'busy' };
    default:
      // Not found, and every refusal, look the same to a visitor: the page
      // teaches nothing to someone guessing numbers.
      return { status: 'not_found' };
  }
}
`;
}

const SHARED_TEXT = {
  en: `    issued: 'Issued',
    pages: 'Pages',
    view: 'View',
    download: 'Download',
    page: 'Document page',
    expiry: 'These links work for ${String(LINK_MINUTES)} minutes. Open the page again for fresh ones.',`,
  ar: `    issued: 'تاريخ الإصدار',
    pages: 'عدد الصفحات',
    view: 'عرض',
    download: 'تنزيل',
    page: 'صفحة المستند',
    expiry: 'تعمل هذه الروابط لمدة ${String(LINK_MINUTES)} دقائق. افتح الصفحة مرة أخرى للحصول على روابط جديدة.',`,
};

function searchFile(): string {
  return `'use client';

import { useActionState } from 'react';
import { searchDocument, type SearchState } from './actions';

const TEXT = {
  en: {
    title: 'Find your document',
    intro: 'Enter the number or code you were given, such as the reference printed on your certificate.',
    label: 'Reference or code',
    search: 'Search',
    searching: 'Searching…',
    missing: 'Please enter what you were given.',
    notFound: 'No document matches. Check what you typed and try again.',
    busy: 'Too many searches right now. Please try again in a minute.',
${SHARED_TEXT.en}
  },
  ar: {
    title: 'ابحث عن مستندك',
    intro: 'أدخل الرقم أو الرمز الذي حصلت عليه، مثل الرقم المرجعي المطبوع على الشهادة.',
    label: 'المرجع أو الرمز',
    search: 'بحث',
    searching: 'جارٍ البحث…',
    missing: 'يُرجى إدخال ما حصلت عليه.',
    notFound: 'لا يوجد مستند مطابق. تحقّق مما كتبته وحاول مرة أخرى.',
    busy: 'عمليات بحث كثيرة الآن. يُرجى المحاولة بعد دقيقة.',
${SHARED_TEXT.ar}
  },
} as const;

const INITIAL: SearchState = { status: 'idle' };

export function DocumentSearch({ language }: { language: 'en' | 'ar' }) {
  const text = TEXT[language];
  const [state, search, searching] = useActionState(searchDocument, INITIAL);
  const documents = state.status === 'found' ? (state.documents ?? []) : [];
  const date = new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
  });
  return (
    <section className="integr8-search" dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
      <h1>{text.title}</h1>
      <p>{text.intro}</p>
      <form action={search} className="integr8-search__form">
        <label className="integr8-search__field">
          <span>{text.label}</span>
          <input name="q" autoComplete="off" maxLength={500} required />
        </label>
        <button type="submit" disabled={searching}>
          {searching ? text.searching : text.search}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'missing' ? <p role="alert">{text.missing}</p> : null}
        {state.status === 'not_found' ? <p role="alert">{text.notFound}</p> : null}
        {state.status === 'busy' ? <p role="alert">{text.busy}</p> : null}
        {documents.length === 0 ? null : (
          <ul className="integr8-search__results">
            {documents.map((document) => (
              <li key={document.viewUrl} className="integr8-search__result">
                <h2>{document.title}</h2>
                {document.formTitle === '' ? null : <p>{document.formTitle}</p>}
                <p>
                  {text.issued}: {date.format(new Date(document.createdAt))}
                  {document.pageCount === null ? null : (
                    <>
                      {' · '}
                      {text.pages}: {document.pageCount}
                    </>
                  )}
                </p>
                <p className="integr8-search__actions">
                  <a href={document.viewUrl} target="_blank" rel="noopener noreferrer">
                    {text.view}
                  </a>
                  <a href={document.downloadUrl} rel="noopener noreferrer">
                    {text.download}
                  </a>
                  {document.link === null ? null : (
                    <a href={document.link} target="_blank" rel="noopener noreferrer">
                      {text.page}
                    </a>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {documents.length === 0 ? null : <p className="integr8-search__note">{text.expiry}</p>}
      </div>
    </section>
  );
}
`;
}

function languageProps(language: PageLanguage): {
  signature: string;
  read: string;
  value: string;
} {
  return language === 'both'
    ? {
        signature: 'searchParams: Promise<{ lang?: string }>',
        read: "  const { lang } = await searchParams;\n  const language = lang === 'ar' ? 'ar' : 'en';\n",
        value: 'language',
      }
    : {
        signature: '',
        read: `  const language: 'en' | 'ar' = '${language}';
`,
        value: 'language',
      };
}

function searchPageFile(language: PageLanguage): string {
  const meta = `export const metadata: Metadata = {
  title: ${language === 'ar' ? "'ابحث عن مستندك'" : "'Find your document'"},
  robots: { index: false },
};
`;
  if (language === 'both') {
    return `import type { Metadata } from 'next';
import { DocumentSearch } from './document-search';

${meta}
/** English by default; \`?lang=ar\` for Arabic. Use the site's own locale routing if it has one. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  return <DocumentSearch language={lang === 'ar' ? 'ar' : 'en'} />;
}
`;
  }
  return `import type { Metadata } from 'next';
import { DocumentSearch } from './document-search';

${meta}
export default function Page() {
  return <DocumentSearch language="${language}" />;
}
`;
}

function documentPageFile(language: PageLanguage): string {
  const props = languageProps(language);
  const params =
    props.signature === ''
      ? '{ params }: { params: Promise<{ code: string }> }'
      : `{
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  ${props.signature};
}`;
  return `import type { Metadata } from 'next';
import { documentByCode } from '@/lib/integr8';

/**
 * The page a shared document link and a new QR code open: /documents/<code>.
 * Rendered on the server for every visit, so the five-minute links are fresh.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: ${language === 'ar' ? "'مستند'" : "'Document'"},
  robots: { index: false },
};

const TEXT = {
  en: {
    notFound: 'This link is not valid.',
    notFoundHint: 'The document may have been withdrawn. Ask the company for a new link.',
    busy: 'Too many visits right now. Please try again in a minute.',
${SHARED_TEXT.en}
  },
  ar: {
    notFound: 'هذا الرابط غير صالح.',
    notFoundHint: 'ربما سُحب المستند. اطلب من الشركة رابطًا جديدًا.',
    busy: 'زيارات كثيرة الآن. يُرجى المحاولة بعد دقيقة.',
${SHARED_TEXT.ar}
  },
} as const;

export default async function Page(${params}) {
  const { code } = await params;
${props.read}  const text = TEXT[${props.value}];
  const outcome = await documentByCode(code);
  const dir = ${props.value} === 'ar' ? 'rtl' : 'ltr';

  if (outcome.kind !== 'found') {
    // Not found, and every refusal, look the same to a visitor.
    return (
      <section className="integr8-document" dir={dir} lang={${props.value}}>
        <h1>{outcome.kind === 'busy' ? text.busy : text.notFound}</h1>
        {outcome.kind === 'busy' ? null : <p>{text.notFoundHint}</p>}
      </section>
    );
  }

  const document = outcome.document;
  const date = new Intl.DateTimeFormat(${props.value} === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
  });
  return (
    <section className="integr8-document" dir={dir} lang={${props.value}}>
      <h1>{document.title}</h1>
      {document.formTitle === '' ? null : <p>{document.formTitle}</p>}
      <p>
        {text.issued}: {date.format(new Date(document.createdAt))}
        {document.pageCount === null ? null : (
          <>
            {' · '}
            {text.pages}: {document.pageCount}
          </>
        )}
      </p>
      {document.fields.length === 0 ? null : (
        <dl className="integr8-document__fields">
          {document.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label[${props.value}] ?? field.label.en ?? field.key}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="integr8-document__actions">
        <a href={document.viewUrl} target="_blank" rel="noopener noreferrer">
          {text.view}
        </a>
        <a href={document.downloadUrl} rel="noopener noreferrer">
          {text.download}
        </a>
      </p>
      <p className="integr8-document__note">{text.expiry}</p>
    </section>
  );
}
`;
}

function envFile(): string {
  return `# Integr8 Plus: the shared PDF pages. Server only: never prefix with NEXT_PUBLIC_.
# Put the real values in .env.local (not committed) and in Vercel's Environment Variables.
${ENV_API_URL}=https://api.integr8-media.com
${ENV_WEBSITE_KEY}=
`;
}

function checkedRoute(route: string): string {
  if (!ROUTE_PATTERN.test(route)) {
    throw new Error(
      `"${route}" is not a route folder: use lowercase words joined by "/", like "certificates" or "[locale]/certificates".`,
    );
  }
  return route;
}

/** The files to add to the website, with where each goes. */
export function nextExample(options: NextExampleOptions = {}): GeneratedFile[] {
  const route = checkedRoute(options.route ?? 'certificates');
  const documentRoute = checkedRoute(options.documentRoute ?? DEFAULT_DOCUMENT_ROUTE);
  if (route === documentRoute) {
    throw new Error('The search page and the document page need different folders.');
  }
  const base = options.srcDir === true ? 'src/' : '';
  const folder = `${base}app/${route}`;
  const language = options.language ?? 'both';
  return [
    {
      path: `${base}lib/integr8.ts`,
      purpose:
        'The server-only calls to Integr8 (reads the key from the environment; `server-only` makes the build fail if browser code imports it).',
      content: clientFile(),
    },
    {
      path: `${folder}/actions.ts`,
      purpose: 'The Server Action the search form posts to: checks the input and calls the search.',
      content: actionsFile(),
    },
    {
      path: `${folder}/document-search.tsx`,
      purpose: `The one search box and the list of matches (at most ${String(SEARCH_LIMIT)}), client component, English and Arabic, right-to-left in Arabic.`,
      content: searchFile(),
    },
    {
      path: `${folder}/page.tsx`,
      purpose: 'The search page itself (server component). Not indexed by search engines.',
      content: searchPageFile(language),
    },
    {
      path: `${base}app/${documentRoute}/[code]/page.tsx`,
      purpose: `The document page every shared link and new QR code opens (/${documentRoute}/<code>; server component, rendered per visit, not indexed). Its address must match the document link address Integr8 sets for the company.`,
      content: documentPageFile(language),
    },
    {
      path: '.env.example',
      purpose:
        'Add these two lines (names only). The real key goes in .env.local and in Vercel, never in a committed file.',
      content: envFile(),
    },
  ];
}

/** The example as the AI reads it: what to install, each file, and what to do next. */
export function nextExampleText(options: NextExampleOptions = {}): string {
  const files = nextExample(options);
  const documentRoute = options.documentRoute ?? DEFAULT_DOCUMENT_ROUTE;
  const parts = [
    '# Shared PDF pages for a Next.js website (App Router, React 19 / Next.js 15 or newer)',
    '',
    "Install the one extra package: `npm install server-only` (or the project's package manager). The `@/` import alias must point at the project root (or `src/`) as in a default Next.js app; otherwise use a relative import.",
    'Fit the files to the project: its styling (the markup uses plain `integr8-search__…` and `integr8-document__…` class names, so the site\'s own design takes over), its layout, its own i18n and locale routing if it has them. Keep the rules: key only on the server, one "not found" for every failure, links used at once.',
    '',
    ...files.flatMap((file) => [
      `## ${file.path}`,
      '',
      file.purpose,
      '',
      `\`\`\`${file.path.endsWith('.tsx') ? 'tsx' : file.path.endsWith('.ts') ? 'ts' : 'sh'}`,
      file.content.trimEnd(),
      '```',
      '',
    ]),
    '## Next',
    '',
    `1. The developer puts ${ENV_API_URL} and ${ENV_WEBSITE_KEY} in .env.local and in Vercel → Settings → Environment Variables, then redeploys.`,
    `2. Tell Integr8 the document page's address, \`https://<the site>/${documentRoute}/{code}\`: staff set it as the company's document link address, and from then on shared links and new QR codes open this page. Until then they open Integr8's own page.`,
    '3. Call check_website_integration with the website folder and fix what it reports.',
    "4. Test with a document the company has shared (Sharing on in its Documents register): search for its reference, and open its link from the company's app. Try a wrong number and a made-up code too. Run the dev server and try it; do not call the API from this tool.",
    '5. Add a per-visitor limit in front of the pages (Vercel Firewall rate limiting, or middleware): the Integr8 limit is per key, shared by all visitors.',
  ];
  return parts.join('\n');
}
