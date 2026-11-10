import { z } from 'zod';

/**
 * A change request (P39): what a person building a form wanted that the
 * platform cannot do yet, captured on the spot with its example, as a folder
 * that is later copied into the repository's `plan/requests/`.
 *
 *   CR-<number>-<slug>/
 *     request.md            a header and four parts (this file's format)
 *     example.integr8form   the form and PDF templates being built, even unfinished
 *     example.json          the same as JSON, when it could not be packed
 *     preview-*.png         the Form tab and each PDF, when a browser is available
 *
 * The header is a Markdown table so a person reads it as easily as the tools
 * do; `parseRequest` reads it back and `requestHeaderSchema` checks it. The
 * format is written down in docs/forms-ai/change-requests.md.
 */

export const REQUEST_KINDS = [
  'form_format',
  'pdf_design',
  'form_action',
  'app_screen',
  'other',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ['open', 'merged', 'dropped', 'handed_over'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const requestHeaderSchema = z.object({
  number: z.number().int().min(1).max(9999),
  title: z.string().trim().min(3).max(120),
  date: z.iso.date(),
  kind: z.enum(REQUEST_KINDS),
  status: z.enum(REQUEST_STATUSES),
  /** The request this one was merged into. */
  mergedInto: z.number().int().min(1).max(9999).nullable(),
  /** The form being built, by its English title. */
  form: z.string().max(200).nullable(),
  /** Which Forms for AI made it. */
  madeWith: z.string().max(80),
});

export type RequestHeader = z.infer<typeof requestHeaderSchema>;

export interface RequestBody {
  /** What was wanted, in the person's words. */
  wanted: string;
  why: string;
  /** What blocked it: the check's refusal, or what the format lacks. */
  blocked: string;
  /** The AI's questions and the person's answers. */
  answers: { question: string; answer: string }[];
}

export interface ChangeRequest extends RequestBody {
  header: RequestHeader;
}

export const PARTS = {
  wanted: 'What was wanted',
  why: 'Why',
  blocked: 'What blocked it',
  answers: 'Answers to the questions',
} as const;

/** `CR-0007`. */
export const requestCode = (number: number) => `CR-${String(number).padStart(4, '0')}`;

/** A folder name from the number and title: lower case, ASCII, hyphens. */
export function requestFolderName(number: number, title: string): string {
  const slug =
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48)
      .replace(/-+$/u, '') || 'request';
  return `${requestCode(number)}-${slug}`;
}

const cell = (value: string) => value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ');

export function renderRequest(request: ChangeRequest): string {
  const { header } = request;
  const rows: [string, string][] = [
    ['Number', String(header.number)],
    ['Date', header.date],
    ['Kind', `\`${header.kind}\``],
    ['Status', `\`${header.status}\``],
    ...(header.mergedInto === null
      ? []
      : ([['Merged into', requestCode(header.mergedInto)]] as [string, string][])),
    ['Form', header.form ?? '—'],
    ['Made with', header.madeWith],
  ];
  const answers =
    request.answers.length === 0
      ? '_None asked._'
      : request.answers
          .map(
            (entry) =>
              `- **${entry.question.trim()}**\n  ${entry.answer.trim().replace(/\n/gu, '\n  ')}`,
          )
          .join('\n');
  return [
    `# ${requestCode(header.number)} — ${header.title}`,
    '',
    '| Field | Value |',
    '| ----- | ----- |',
    ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`),
    '',
    `## ${PARTS.wanted}`,
    '',
    request.wanted.trim(),
    '',
    `## ${PARTS.why}`,
    '',
    request.why.trim(),
    '',
    `## ${PARTS.blocked}`,
    '',
    request.blocked.trim(),
    '',
    `## ${PARTS.answers}`,
    '',
    answers,
    '',
  ].join('\n');
}

export class RequestFormatError extends Error {}

function part(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start === -1) {
    return '';
  }
  const from = start + title.length + 5;
  const next = text.indexOf('\n## ', from);
  return text.slice(from, next === -1 ? undefined : next).trim();
}

/** Reads a request.md back; throws a RequestFormatError naming what is wrong. */
export function parseRequest(text: string): ChangeRequest {
  const normalised = text.replace(/\r\n/gu, '\n');
  const title = /^# CR-\d{4} — (.+)$/mu.exec(normalised)?.[1]?.trim();
  const rows = new Map<string, string>();
  for (const match of normalised.matchAll(/^\| ([A-Za-z ]+?) \| (.*?) \|$/gmu)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined && name !== 'Field' && !/^-+$/u.test(name)) {
      rows.set(name, value.replace(/^`|`$/gu, '').replace(/\\\|/gu, '|').trim());
    }
  }
  const merged = rows.get('Merged into');
  const parsed = requestHeaderSchema.safeParse({
    number: Number(rows.get('Number')),
    title,
    date: rows.get('Date'),
    kind: rows.get('Kind'),
    status: rows.get('Status'),
    mergedInto: merged === undefined ? null : Number(merged.replace(/^CR-/u, '')),
    form: rows.get('Form') === undefined || rows.get('Form') === '—' ? null : rows.get('Form'),
    madeWith: rows.get('Made with') ?? '',
  });
  if (!parsed.success) {
    throw new RequestFormatError(
      `The request's header is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  }
  const answersText = part(normalised, PARTS.answers);
  const answers = [...answersText.matchAll(/^- \*\*(.+?)\*\*\n((?: {2}.*\n?)*)/gmu)].map(
    (match) => ({
      question: match[1]?.trim() ?? '',
      answer: (match[2] ?? '').replace(/^ {2}/gmu, '').trim(),
    }),
  );
  return {
    header: parsed.data,
    wanted: part(normalised, PARTS.wanted),
    why: part(normalised, PARTS.why),
    blocked: part(normalised, PARTS.blocked),
    answers,
  };
}
