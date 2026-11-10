import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { readAsset, WINDOW_PAGE } from '../assets.js';
import { formatCheck } from '../mcp/report.js';
import { confirmSection, summarizeForm } from '../mcp/interview.js';
import type { WindowPrinter } from './printer.js';
import type { PreviewSession, PrintOptions, WindowTab, WindowView } from './session.js';

/**
 * The preview window's page server (P37), on Node's own `http`.
 *
 * Safety rules, each with a test (`server.test.ts`):
 *
 * - It listens on 127.0.0.1 only, on a port the system picks.
 * - Every request must carry the random token made at start (`?k=`); one
 *   without it gets 404, as if nothing were there.
 * - The `Host` header must be exactly `127.0.0.1:<port>`. A web page that
 *   points a hostname of its own at 127.0.0.1 (DNS rebinding) sends its own
 *   name, and is refused. A request whose `Origin` is another site is
 *   refused too, and no CORS headers are ever sent, so another site's page
 *   can neither read an answer nor send one.
 * - The page may load scripts, styles, fonts and pictures from this server
 *   only, and may connect nowhere else (Content-Security-Policy).
 */

export interface SaveRequest {
  fileName: string | undefined;
  overwrite: boolean;
}

export type SaveOutcome =
  | { kind: 'saved'; path: string; replaced: boolean; ok: boolean }
  | { kind: 'exists'; path: string };

export interface WindowServerOptions {
  session: PreviewSession;
  printer: WindowPrinter;
  /** Saves the session's form file, as save_package does. */
  save: (request: SaveRequest) => SaveOutcome;
  /** Where Save writes, shown on the page. */
  outputFolder: string;
  /** The built page; tests pass a stand-in. */
  readPage?: () => { script: Uint8Array; style: Uint8Array };
  /** The change requests recorded on this computer (P39), for the window's list. */
  listRequests?: () => {
    number: number;
    title: string;
    kind: string;
    status: string;
    date: string;
  }[];
}

export interface WindowServer {
  /** The address to open, token included. */
  readonly url: string;
  readonly port: number;
  /** How many pages are listening to the event stream now. */
  connections(): number;
  close(): Promise<void>;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

const JSON_LIMIT = 8 * 1024 * 1024;
const MEDIA_LIMIT = 12 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TABS: readonly WindowTab[] = ['form', 'pdf', 'checks'];
const NOTE_LIMIT = 2000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE_HEADERS: OutgoingHttpHeaders = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cache-Control': 'no-store',
};

function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  type: string,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...headers });
  response.end(body);
}

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
};

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, 'Too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON.');
  }
  const body = await readBody(request, JSON_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Send a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sameToken = (given: string | null, token: string): boolean => {
  if (given === null) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

function templateLanguage(design: unknown): 'en' | 'ar' | null {
  const language = record(record(design).page).language;
  return language === 'en' || language === 'ar' ? language : null;
}

/** What the page draws: the session, without the designs and pictures it does not need. */
export function snapshot(
  session: PreviewSession,
  printer: WindowPrinter,
  outputFolder: string,
): Record<string, unknown> {
  const content = session.content;
  const check = session.check;
  const prints: Record<string, unknown> = {};
  for (const [index, print] of session.prints) {
    prints[String(index)] = {
      status: print.status,
      version: print.version,
      options: print.options,
      by: print.by,
      at: print.at,
      message: print.message ?? null,
      pageCount: print.pageCount ?? null,
    };
  }
  return {
    version: session.version,
    hasContent: content !== undefined,
    definition: content?.definition ?? null,
    templates: (content?.templates ?? []).map((template) => ({
      name: template.name,
      language: templateLanguage(template.design),
    })),
    check:
      check === undefined
        ? null
        : { ok: check.ok, problems: check.problems, warnings: check.warnings },
    checkText:
      check === undefined || content === undefined
        ? ''
        : formatCheck(check, content.templates.length === 0 ? 'form' : 'package') +
          confirmSection(content.templates),
    summary:
      content === undefined
        ? ''
        : summarizeForm(content.definition, content.templates) + confirmSection(content.templates),
    answers: session.answers,
    submitted: session.submitted ?? null,
    prints,
    printing: { available: printer.available() },
    view: session.view,
    outputFolder,
  };
}

const PAGE_HTML = (token: string) => `<!doctype html>
<html lang="en" dir="ltr" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Integr8 Forms preview</title>
<link rel="stylesheet" href="/page.css?k=${token}">
</head>
<body>
<div id="root"></div>
<script src="/page.js?k=${token}"></script>
</body>
</html>
`;

function printOptions(body: Record<string, unknown>): PrintOptions {
  const language = body.language;
  const colour = body.companyColour;
  return {
    useAnswers: body.useAnswers === true,
    language: language === 'en' || language === 'ar' ? language : undefined,
    companyColour:
      typeof colour === 'string' && /^#[0-9a-fA-F]{6}$/u.test(colour) ? colour : undefined,
  };
}

function viewChange(body: Record<string, unknown>): Partial<WindowView> {
  const change: Partial<WindowView> = {};
  if (TABS.includes(body.tab as WindowTab)) {
    change.tab = body.tab as WindowTab;
  }
  if (body.language === 'en' || body.language === 'ar') {
    change.language = body.language;
  }
  if (body.width === 'phone' || body.width === 'desktop') {
    change.width = body.width;
  }
  if (body.theme === 'light' || body.theme === 'dark') {
    change.theme = body.theme;
  }
  return change;
}

export async function startWindowServer(options: WindowServerOptions): Promise<WindowServer> {
  const { session, printer } = options;
  const token = randomBytes(24).toString('hex');
  const streams = new Set<ServerResponse>();
  let port = 0;

  const readPage =
    options.readPage ??
    (() => {
      // Read on first use, so a server started from source without a built
      // page still answers everything but the page itself.
      return { script: readAsset(WINDOW_PAGE.script), style: readAsset(WINDOW_PAGE.style) };
    });

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== `127.0.0.1:${String(port)}`) {
      send(response, 403, 'Refused.', 'text/plain; charset=utf-8');
      return;
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`);
    if (!sameToken(url.searchParams.get('k'), token)) {
      send(response, 404, 'Not found.', 'text/plain; charset=utf-8');
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${String(port)}`) {
      send(response, 403, 'Refused.', 'text/plain; charset=utf-8');
      return;
    }
    const method = request.method ?? 'GET';
    const route = `${method} ${url.pathname}`;

    if (route === 'GET /') {
      send(response, 200, PAGE_HTML(token), 'text/html; charset=utf-8');
      return;
    }
    if (route === 'GET /page.js' || route === 'GET /page.css') {
      let page: { script: Uint8Array; style: Uint8Array };
      try {
        page = readPage();
      } catch {
        throw new HttpError(
          503,
          'The window page is not built. Run: pnpm --filter @integr8/forms-ai build',
        );
      }
      if (url.pathname === '/page.js') {
        send(response, 200, page.script, 'text/javascript; charset=utf-8');
      } else {
        send(response, 200, page.style, 'text/css; charset=utf-8');
      }
      return;
    }
    if (route === 'GET /state') {
      sendJson(response, 200, snapshot(session, printer, options.outputFolder));
      return;
    }
    if (route === 'GET /events') {
      response.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      response.write(
        `retry: 2000\n\nevent: state\ndata: {"version":${String(session.version)}}\n\n`,
      );
      streams.add(response);
      const stop = session.subscribe((event) => {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const ping = setInterval(() => {
        response.write(': still here\n\n');
      }, 20_000);
      ping.unref();
      response.on('close', () => {
        clearInterval(ping);
        stop();
        streams.delete(response);
      });
      return;
    }
    if (route === 'POST /answers') {
      const body = await readJson(request);
      session.setAnswers(record(body.answers));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'POST /submit') {
      const body = await readJson(request);
      session.setSubmitted(record(body.answers));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'POST /view') {
      session.setView(viewChange(await readJson(request)));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'POST /print') {
      const body = await readJson(request);
      const template = body.template;
      if (typeof template !== 'number' || !Number.isInteger(template)) {
        throw new HttpError(400, 'Which template?');
      }
      try {
        const print = printer.request(template, printOptions(body));
        sendJson(response, 202, { status: print.status });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new HttpError(404, error.message);
        }
        throw error;
      }
      return;
    }
    const pdf = /^\/pdf\/(\d{1,3})$/u.exec(url.pathname);
    if (method === 'GET' && pdf !== null) {
      const index = Number(pdf[1]);
      const print = session.print(index);
      if (print?.pdfPath === undefined) {
        throw new HttpError(404, 'Not printed yet.');
      }
      const name = session.content?.templates[index]?.name ?? 'preview';
      send(response, 200, readFileSync(print.pdfPath), 'application/pdf', {
        'Content-Disposition': `inline; filename="${encodeURIComponent(name)}.pdf"`,
      });
      return;
    }
    if (route === 'POST /media') {
      const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      if (!MEDIA_TYPES.has(type)) {
        throw new HttpError(415, 'A photo or signature must be a PNG, JPEG or WebP picture.');
      }
      const bytes = await readBody(request, MEDIA_LIMIT);
      const id = session.addMedia({ contentType: type, bytes: new Uint8Array(bytes) });
      if (id === undefined) {
        throw new HttpError(413, 'The window holds no more pictures; save and reopen it.');
      }
      sendJson(response, 201, { mediaId: id, contentType: type, byteSize: bytes.length });
      return;
    }
    const media = /^\/media\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (method === 'GET' && media !== null) {
      const stored = session.media(media[1] ?? '');
      if (stored === undefined) {
        throw new HttpError(404, 'No such picture.');
      }
      send(response, 200, stored.bytes, stored.contentType);
      return;
    }
    if (route === 'POST /note') {
      const body = await readJson(request);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '' || text.length > NOTE_LIMIT) {
        throw new HttpError(400, `A note is 1 to ${String(NOTE_LIMIT)} characters.`);
      }
      const tab = TABS.includes(body.tab as WindowTab) ? (body.tab as WindowTab) : 'form';
      const about =
        typeof body.about === 'string' && body.about !== '' ? body.about.slice(0, 200) : undefined;
      const note = session.addNote({ tab, about, text, platform: body.platform === true });
      sendJson(response, 201, { id: note.id });
      return;
    }
    if (route === 'GET /requests') {
      sendJson(response, 200, { items: options.listRequests?.() ?? [] });
      return;
    }
    if (route === 'POST /save') {
      if (session.content === undefined) {
        throw new HttpError(409, 'There is no form to save yet.');
      }
      const body = await readJson(request);
      const fileName =
        typeof body.fileName === 'string' && body.fileName.trim() !== ''
          ? body.fileName.slice(0, 120)
          : undefined;
      const outcome = options.save({ fileName, overwrite: body.overwrite === true });
      if (outcome.kind === 'exists') {
        sendJson(response, 409, { exists: true, path: outcome.path });
      } else {
        sendJson(response, 200, outcome);
      }
      return;
    }
    send(response, 404, 'Not found.', 'text/plain; charset=utf-8');
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  // The window must never keep the program running after the AI tool has gone.
  server.unref();

  return {
    url: `http://127.0.0.1:${String(port)}/?k=${token}`,
    port,
    connections: () => streams.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) {
          stream.end();
        }
        streams.clear();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
