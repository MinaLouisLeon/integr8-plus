import { ENV_API_URL, ENV_WEBSITE_KEY, LINK_MINUTES } from './contract.js';

/**
 * The search and download page for a company's Next.js website
 * (`get_website_example`): a server-only client for the lookup, a Server
 * Action, the page and its form, in English and Arabic.
 *
 * The code follows docs/documents/WEBSITE-LOOKUP.md: the key is read only on
 * the server, the visitor sees one "not found" whatever went wrong, the
 * five-minute links are used at once and never stored. `nextjs.test.ts`
 * compiles every variant and runs `check_website_integration` over it, so
 * the example always passes the program's own check.
 */

export type SecondValue = 'required' | 'optional' | 'none';
export type PageLanguage = 'en' | 'ar' | 'both';

export interface NextExampleOptions {
  /** The page's path under the app folder, e.g. "certificates" or "[locale]/certificates". */
  route?: string | undefined;
  /** The project keeps its app folder in `src/`. */
  srcDir?: boolean | undefined;
  /** Whether visitors must also type the customer name. */
  secondValue?: SecondValue | undefined;
  /** Which language the page shows; "both" reads `?lang=ar`. */
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
 * Integr8 Plus: finds one shared PDF document for a visitor.
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
  viewUrl: string;
  downloadUrl: string;
  expiresAt: string;
  fields: Integr8DocumentField[];
}

export type LookupOutcome =
  | { kind: 'found'; document: Integr8Document }
  | { kind: 'not_found' }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

const LOOKUP_PATH = '/v1/website/documents/lookup';

export async function lookupDocument(reference: string, customer?: string): Promise<LookupOutcome> {
  const apiUrl = process.env.${ENV_API_URL};
  const key = process.env.${ENV_WEBSITE_KEY};
  if (!apiUrl || !key) {
    console.error('Integr8 lookup: ${ENV_API_URL} or ${ENV_WEBSITE_KEY} is not set.');
    return { kind: 'unavailable' };
  }
  let response: Response;
  try {
    response = await fetch(apiUrl.replace(/\\/+$/, '') + LOOKUP_PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'x-client-app': 'company-website',
      },
      body: JSON.stringify(customer ? { reference, customer } : { reference }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error('Integr8 lookup: no answer', error);
    return { kind: 'unavailable' };
  }
  if (response.status === 429) {
    return { kind: 'busy' };
  }
  if (!response.ok) {
    // 401: the key is wrong, disabled or revoked. 403: a switch is off.
    // 422: this code sent a wrong body. Logged here, never shown to visitors.
    console.error('Integr8 lookup refused', response.status, await response.text());
    return { kind: 'unavailable' };
  }
  const body = (await response.json()) as { found: boolean; document: Integr8Document | null };
  return body.found && body.document !== null
    ? { kind: 'found', document: body.document }
    : { kind: 'not_found' };
}
`;
}

function actionsFile(secondValue: SecondValue): string {
  const customerRead =
    secondValue === 'none' ? '' : `  const customer = String(form.get('customer') ?? '').trim();\n`;
  const missing =
    secondValue === 'required' ? `reference === '' || customer === ''` : `reference === ''`;
  const tooLong =
    secondValue === 'none'
      ? `reference.length > 500`
      : `reference.length > 500 || customer.length > 500`;
  const call =
    secondValue === 'none'
      ? `lookupDocument(reference)`
      : `lookupDocument(reference, customer === '' ? undefined : customer)`;
  return `'use server';

import { lookupDocument } from '@/lib/integr8';

/** What the page shows. The five-minute links go straight to the visitor and are never stored. */
export interface SearchState {
  status: 'idle' | 'found' | 'not_found' | 'busy' | 'missing';
  document?: {
    title: string;
    formTitle: string;
    createdAt: string;
    pageCount: number | null;
    link: string | null;
    viewUrl: string;
    downloadUrl: string;
    expiresAt: string;
  };
}

export async function searchDocument(_previous: SearchState, form: FormData): Promise<SearchState> {
  const reference = String(form.get('reference') ?? '').trim();
${customerRead}  if (${missing}) {
    return { status: 'missing' };
  }
  if (${tooLong}) {
    return { status: 'not_found' };
  }
  const outcome = await ${call};
  switch (outcome.kind) {
    case 'found': {
      const { title, formTitle, createdAt, pageCount, link, viewUrl, downloadUrl, expiresAt } =
        outcome.document;
      return {
        status: 'found',
        document: { title, formTitle, createdAt, pageCount, link, viewUrl, downloadUrl, expiresAt },
      };
    }
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

function searchFile(secondValue: SecondValue): string {
  const customerIntro =
    secondValue === 'required'
      ? ` and the customer name it was issued to`
      : secondValue === 'optional'
        ? ` and, if it shows one, the customer name`
        : '';
  const customerIntroAr =
    secondValue === 'required'
      ? ` واسم العميل الصادر باسمه`
      : secondValue === 'optional'
        ? ` واسم العميل إن وُجد عليه`
        : '';
  const customerInput =
    secondValue === 'none'
      ? ''
      : `
        <label className="integr8-search__field">
          <span>{text.customer}</span>
          <input name="customer" autoComplete="off" maxLength={500}${secondValue === 'required' ? ' required' : ''} />
        </label>`;
  const customerText =
    secondValue === 'none'
      ? ['', '']
      : [
          `\n    customer: '${secondValue === 'optional' ? 'Customer name (if shown)' : 'Customer name'}',`,
          `\n    customer: '${secondValue === 'optional' ? 'اسم العميل (إن وُجد)' : 'اسم العميل'}',`,
        ];
  return `'use client';

import { useActionState } from 'react';
import { searchDocument, type SearchState } from './actions';

const TEXT = {
  en: {
    title: 'Find your document',
    intro: 'Enter the reference number printed on your certificate${customerIntro}.',
    reference: 'Reference number',${customerText[0]}
    search: 'Search',
    searching: 'Searching…',
    missing: 'Please fill in every field.',
    notFound: 'No document matches these details. Check them and try again.',
    busy: 'Too many searches right now. Please try again in a minute.',
    issued: 'Issued',
    pages: 'Pages',
    view: 'View',
    download: 'Download',
    page: 'Document page',
    expiry: 'These links work for ${String(LINK_MINUTES)} minutes. Search again for fresh ones.',
  },
  ar: {
    title: 'ابحث عن مستندك',
    intro: 'أدخل الرقم المرجعي المطبوع على الشهادة${customerIntroAr}.',
    reference: 'الرقم المرجعي',${customerText[1]}
    search: 'بحث',
    searching: 'جارٍ البحث…',
    missing: 'يُرجى ملء كل الحقول.',
    notFound: 'لا يوجد مستند يطابق هذه البيانات. تحقّق منها وحاول مرة أخرى.',
    busy: 'عمليات بحث كثيرة الآن. يُرجى المحاولة بعد دقيقة.',
    issued: 'تاريخ الإصدار',
    pages: 'عدد الصفحات',
    view: 'عرض',
    download: 'تنزيل',
    page: 'صفحة المستند',
    expiry: 'تعمل هذه الروابط لمدة ${String(LINK_MINUTES)} دقائق. ابحث مرة أخرى للحصول على روابط جديدة.',
  },
} as const;

const INITIAL: SearchState = { status: 'idle' };

export function DocumentSearch({ language }: { language: 'en' | 'ar' }) {
  const text = TEXT[language];
  const [state, search, searching] = useActionState(searchDocument, INITIAL);
  const document = state.status === 'found' ? state.document : undefined;
  return (
    <section className="integr8-search" dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
      <h1>{text.title}</h1>
      <p>{text.intro}</p>
      <form action={search} className="integr8-search__form">
        <label className="integr8-search__field">
          <span>{text.reference}</span>
          <input name="reference" autoComplete="off" maxLength={500} required />
        </label>${customerInput}
        <button type="submit" disabled={searching}>
          {searching ? text.searching : text.search}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'missing' ? <p role="alert">{text.missing}</p> : null}
        {state.status === 'not_found' ? <p role="alert">{text.notFound}</p> : null}
        {state.status === 'busy' ? <p role="alert">{text.busy}</p> : null}
        {document === undefined ? null : (
          <article className="integr8-search__result">
            <h2>{document.title}</h2>
            {document.formTitle === '' ? null : <p>{document.formTitle}</p>}
            <p>
              {text.issued}:{' '}
              {new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-GB', {
                dateStyle: 'long',
              }).format(new Date(document.createdAt))}
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
            <p className="integr8-search__note">{text.expiry}</p>
          </article>
        )}
      </div>
    </section>
  );
}
`;
}

function pageFile(language: PageLanguage): string {
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

function envFile(): string {
  return `# Integr8 Plus: the shared PDF search. Server only: never prefix with NEXT_PUBLIC_.
# Put the real values in .env.local (not committed) and in Vercel's Environment Variables.
${ENV_API_URL}=https://api.integr8-media.com
${ENV_WEBSITE_KEY}=
`;
}

/** The files to add to the website, with where each goes. */
export function nextExample(options: NextExampleOptions = {}): GeneratedFile[] {
  const route = options.route ?? 'certificates';
  if (!ROUTE_PATTERN.test(route)) {
    throw new Error(
      `"${route}" is not a route folder: use lowercase words joined by "/", like "certificates" or "[locale]/certificates".`,
    );
  }
  const base = options.srcDir === true ? 'src/' : '';
  const folder = `${base}app/${route}`;
  const secondValue = options.secondValue ?? 'required';
  return [
    {
      path: `${base}lib/integr8.ts`,
      purpose:
        'The server-only call to Integr8 (reads the key from the environment; `server-only` makes the build fail if browser code imports it).',
      content: clientFile(),
    },
    {
      path: `${folder}/actions.ts`,
      purpose: 'The Server Action the form posts to: checks the input and calls the lookup.',
      content: actionsFile(secondValue),
    },
    {
      path: `${folder}/document-search.tsx`,
      purpose:
        'The form and the result (client component), English and Arabic, right-to-left in Arabic.',
      content: searchFile(secondValue),
    },
    {
      path: `${folder}/page.tsx`,
      purpose: 'The page itself (server component). Not indexed by search engines.',
      content: pageFile(options.language ?? 'both'),
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
  const parts = [
    '# Shared PDF search page for a Next.js website (App Router, React 19 / Next.js 15 or newer)',
    '',
    "Install the one extra package: `npm install server-only` (or the project's package manager). The `@/` import alias must point at the project root (or `src/`) as in a default Next.js app; otherwise use a relative import.",
    'Fit the files to the project: its styling (the markup uses plain `integr8-search__…` class names), its layout, its own i18n and locale routing if it has them. Keep the rules: key only on the server, one "not found" for every failure, links used at once.',
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
    '2. Call check_website_integration with the website folder and fix what it reports.',
    '3. Test with a document the company has shared (Sharing on in its Documents register) and a wrong number: both must behave as expected. Run the dev server and try it; do not call the API from this tool.',
    '4. Add a per-visitor limit in front of the page (Vercel Firewall rate limiting, or middleware): the Integr8 limit is per key, shared by all visitors.',
  ];
  return parts.join('\n');
}
