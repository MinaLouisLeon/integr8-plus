import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowPrinter } from './printer.js';
import { type SaveRequest, startWindowServer, type WindowServer } from './server.js';
import { PreviewSession } from './session.js';
import { tripForm } from './testing/trip-form.js';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request with full control of the headers, which `fetch` does not give (Host). */
function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: `127.0.0.1:${String(port)}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const root = mkdtempSync(join(tmpdir(), 'forms-ai-window-'));
const session = new PreviewSession();
const printer = new WindowPrinter({ session, scratch: root, browser: () => undefined });
const saves: SaveRequest[] = [];
let server: WindowServer;
let token: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  session.update({ definition: tripForm, templates: [{ name: 'Report', design: {} }] });
  server = await startWindowServer({
    session,
    printer,
    outputFolder: root,
    save: (request) => {
      saves.push(request);
      return request.overwrite
        ? { kind: 'saved', path: join(root, 'Car trip.integr8form'), replaced: true, ok: true }
        : { kind: 'exists', path: join(root, 'Car trip.integr8form') };
    },
    readPage: () => ({
      script: new TextEncoder().encode('console.log(1)'),
      style: new TextEncoder().encode('body{}'),
    }),
  });
  token = new URL(server.url).searchParams.get('k') ?? '';
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the window page server: safety rules', () => {
  it('listens on 127.0.0.1 only, with a long random token in the address', () => {
    const url = new URL(server.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(token).toMatch(/^[0-9a-f]{48}$/u);
  });

  it('answers 404 without the token, or with a wrong one', async () => {
    expect((await call(server.port, '/')).status).toBe(404);
    expect((await call(server.port, '/state')).status).toBe(404);
    expect((await call(server.port, `/state?k=${'0'.repeat(48)}`)).status).toBe(404);
    expect((await call(server.port, `/state?k=${token}`)).status).toBe(200);
  });

  it('refuses another Host (DNS rebinding) and another site as Origin', async () => {
    const path = `/state?k=${token}`;
    expect(
      (await call(server.port, path, { headers: { host: `evil.example:${String(server.port)}` } }))
        .status,
    ).toBe(403);
    expect(
      (await call(server.port, path, { headers: { host: `localhost:${String(server.port)}` } }))
        .status,
    ).toBe(403);
    const posted = await call(server.port, `/answers?k=${token}`, {
      ...json({ answers: { purpose: 'x' } }),
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    });
    expect(posted.status).toBe(403);
    expect(session.answers).not.toHaveProperty('purpose', 'x');
  });

  it('sends a strict Content-Security-Policy and no CORS headers', async () => {
    const page = await call(server.port, `/?k=${token}`);
    expect(page.status).toBe(200);
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toMatch(/default-src 'none'/u);
    expect(policy).toMatch(/script-src 'self'(;|$)/u);
    expect(policy).toMatch(/connect-src 'self'(;|$)/u);
    expect(policy).not.toMatch(/https?:/u);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    // The page itself names nothing outside this server.
    expect(page.body).not.toMatch(/https?:\/\//u);
    expect(page.body).toContain(`/page.js?k=${token}`);
  });

  it('wants JSON for JSON routes', async () => {
    const answer = await call(server.port, `/answers?k=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(answer.status).toBe(415);
  });
});

describe('the window page server: routes', () => {
  it('serves the page bundle', async () => {
    const script = await call(server.port, `/page.js?k=${token}`);
    expect(script.headers['content-type']).toMatch(/javascript/u);
    expect(script.body).toBe('console.log(1)');
    expect((await call(server.port, `/page.css?k=${token}`)).body).toBe('body{}');
  });

  it('gives the state, and keeps what the person typed', async () => {
    expect(
      (await call(server.port, `/answers?k=${token}`, json({ answers: { purpose: 'Audit' } })))
        .status,
    ).toBe(200);
    const state = JSON.parse((await call(server.port, `/state?k=${token}`)).body) as {
      version: number;
      answers: Record<string, unknown>;
      templates: { name: string }[];
      check: { ok: boolean };
      printing: { available: boolean };
    };
    expect(state.answers).toEqual({ purpose: 'Audit' });
    expect(state.templates).toEqual([{ name: 'Report', language: null }]);
    expect(state.printing.available).toBe(false);
    expect(state.version).toBe(session.version);
  });

  it('records Submit, the view and notes', async () => {
    await call(server.port, `/submit?k=${token}`, json({ answers: { purpose: 'Audit' } }));
    expect(session.submitted?.answers).toEqual({ purpose: 'Audit' });
    await call(
      server.port,
      `/view?k=${token}`,
      json({ tab: 'pdf', language: 'ar', width: 'phone' }),
    );
    expect(session.view).toMatchObject({ tab: 'pdf', language: 'ar', width: 'phone' });
    expect(
      (await call(server.port, `/note?k=${token}`, json({ tab: 'form', text: ' ' }))).status,
    ).toBe(400);
    expect(
      (
        await call(
          server.port,
          `/note?k=${token}`,
          json({ tab: 'form', about: 'km', text: 'Required, please' }),
        )
      ).status,
    ).toBe(201);
    expect(session.takeUnreadNotes()).toMatchObject([{ about: 'km', text: 'Required, please' }]);
  });

  it('stores a photo in memory and serves it back; refuses other files', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const stored = await call(server.port, `/media?k=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(stored.status).toBe(201);
    const { mediaId } = JSON.parse(stored.body) as { mediaId: string };
    const back = await call(server.port, `/media/${mediaId}?k=${token}`);
    expect(back.headers['content-type']).toBe('image/png');
    const refused = await call(server.port, `/media?k=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: '<script></script>',
    });
    expect(refused.status).toBe(415);
  });

  it('says why there is no PDF without a browser', async () => {
    const print = await call(
      server.port,
      `/print?k=${token}`,
      json({ template: 0, useAnswers: true }),
    );
    expect(JSON.parse(print.body)).toEqual({ status: 'unavailable' });
    expect((await call(server.port, `/pdf/0?k=${token}`)).status).toBe(404);
    expect((await call(server.port, `/print?k=${token}`, json({ template: 9 }))).status).toBe(404);
  });

  it('serves the last print of a template', async () => {
    const pdf = join(root, 'printed.pdf');
    writeFileSync(pdf, '%PDF-1.7 test');
    session.setPrint(0, {
      status: 'ready',
      version: session.version,
      options: { useAnswers: false, language: undefined, companyColour: undefined },
      by: 'window',
      at: new Date().toISOString(),
      pdfPath: pdf,
    });
    const answer = await call(server.port, `/pdf/0?k=${token}`);
    expect(answer.headers['content-type']).toBe('application/pdf');
    expect(answer.body).toBe('%PDF-1.7 test');
  });

  it('asks before replacing a file on Save', async () => {
    const first = await call(server.port, `/save?k=${token}`, json({ fileName: 'Car trip' }));
    expect(first.status).toBe(409);
    expect(JSON.parse(first.body)).toMatchObject({ exists: true });
    const second = await call(
      server.port,
      `/save?k=${token}`,
      json({ fileName: 'Car trip', overwrite: true }),
    );
    expect(second.status).toBe(200);
    expect(saves).toEqual([
      { fileName: 'Car trip', overwrite: false },
      { fileName: 'Car trip', overwrite: true },
    ]);
  });

  it('streams "state" when the AI changes the form', async () => {
    const events = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/events?k=${token}`,
          headers: { host: `127.0.0.1:${String(server.port)}` },
        },
        (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/u);
          let seen = '';
          let changed = false;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            seen += chunk;
            if (!changed) {
              // The stream opens with the current version; then the AI changes something.
              changed = true;
              session.update({ templates: [] });
            }
            if (seen.includes('"type":"state"')) {
              req.destroy();
              resolve(seen);
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(events).toMatch(/event: state\ndata: \{"type":"state","version":\d+\}/u);
  });
});
