import { describe, expect, it } from 'vitest';
import type { PreviewInput, PreviewResult } from '../mcp/preview.js';
import { type PrintFunction, WindowPrinter } from './printer.js';
import { PreviewSession } from './session.js';
import { tripForm } from './testing/trip-form.js';

const browser = () => ({ path: '/usr/bin/chromium', source: 'standard' as const });
const options = { useAnswers: true, language: undefined, companyColour: undefined };

function session(): PreviewSession {
  const made = new PreviewSession();
  made.update({
    definition: tripForm,
    templates: [
      { name: 'A', design: {} },
      { name: 'B', design: {} },
      { name: 'C', design: {} },
    ],
  });
  return made;
}

/** A print function that waits until told, and remembers what it printed. */
function fakePrinter() {
  const printed: PreviewInput[] = [];
  const releases: (() => void)[] = [];
  const print: PrintFunction = (input) =>
    new Promise<PreviewResult>((resolve) => {
      printed.push(input);
      releases.push(() => {
        resolve({
          check: { ok: true, problems: [], warnings: [] },
          pdfPath: `/scratch/${input.template.name}.pdf`,
          pageCount: 1,
          pageImages: [],
          notes: [],
        });
      });
    });
  return { print, printed, release: () => releases.shift()?.() };
}

describe('printing for the window', () => {
  it('says so, and prints nothing, without a browser', () => {
    const printer = new WindowPrinter({
      session: session(),
      scratch: '/s',
      browser: () => undefined,
    });
    expect(printer.request(0, options)).toMatchObject({ status: 'unavailable' });
    expect(printer.request(0, options).message).toMatch(/Chrome, Edge or Chromium/u);
  });

  it('prints one at a time, and a newer request replaces the waiting one', async () => {
    const shared = session();
    const fake = fakePrinter();
    const printer = new WindowPrinter({
      session: shared,
      scratch: '/s',
      browser,
      print: fake.print,
    });
    printer.request(0, options);
    printer.request(1, options);
    printer.request(2, { ...options, useAnswers: false });
    await Promise.resolve();
    expect(fake.printed.map((input) => input.template.name)).toEqual(['A']);
    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.printed.map((input) => input.template.name)).toEqual(['A', 'C']);
    fake.release();
    await printer.idle();
    expect(shared.print(0)).toMatchObject({ status: 'ready', pdfPath: '/scratch/A.pdf' });
    expect(shared.print(1)).toBeUndefined();
    expect(shared.print(2)).toMatchObject({ status: 'ready', options: { useAnswers: false } });
  });

  it('prints with the typed answers only, or with sample answers', async () => {
    const shared = session();
    shared.setAnswers({ purpose: 'Audit' });
    const fake = fakePrinter();
    const printer = new WindowPrinter({
      session: shared,
      scratch: '/s',
      browser,
      print: fake.print,
    });
    printer.request(0, options);
    await Promise.resolve();
    fake.release();
    await printer.idle();
    printer.request(0, { ...options, useAnswers: false });
    await Promise.resolve();
    fake.release();
    await printer.idle();
    expect(fake.printed[0]).toMatchObject({ answers: { purpose: 'Audit' }, withSamples: false });
    expect(fake.printed[1]).toMatchObject({ answers: undefined, withSamples: true });
    expect(fake.printed.every((input) => input.rasterize === false)).toBe(true);
  });

  it('refuses a template that does not exist', () => {
    const printer = new WindowPrinter({ session: session(), scratch: '/s', browser });
    expect(() => printer.request(7, options)).toThrow(RangeError);
  });
});
