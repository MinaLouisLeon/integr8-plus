import { ar, type Catalogue, en } from '@integr8/i18n/core';
import { escapeHtml } from '../html.js';
import { qrSvg } from '../qr.js';
import { fill } from '../words.js';
import { type DocumentLook, type LookMargins, lookTemplates } from './look.js';
import type {
  BusinessAddress,
  BusinessDocumentData,
  BusinessIssuer,
  BusinessLine,
  BusinessLocale,
  BusinessRenderInput,
  BusinessTotals,
  InvoiceDocumentData,
  JobReportData,
  PurchaseOrderDocumentData,
  QuoteDocumentData,
} from './model.js';

/**
 * Quotes, invoices, purchase orders and job reports as printed pages (1.3.0,
 * decision 11): pure functions from a record's snapshot to one HTML page,
 * which the server prints with Chromium like any other document.
 *
 * In English or Arabic, laid out with logical sides only so Arabic mirrors.
 * Everything anyone typed is escaped; pictures arrive as data URIs the worker
 * made from the company's own bucket, so printing fetches nothing.
 */

type Words = Catalogue<(typeof en)['businessPdfs']['render']>;

export interface RenderedBusinessDocument {
  html: string;
  headerHtml: string;
  footerHtml: string;
  margins: LookMargins;
  /** The page's title: what the register and the PDF's metadata call it. */
  title: string;
}

/** The page's margins, in millimetres: room for the running header and footer. */
export const BUSINESS_MARGINS: LookMargins = { top: 22, bottom: 20, start: 16, end: 16 };

function wordsFor(locale: BusinessLocale): Words {
  return locale === 'ar' ? ar.businessPdfs.render : en.businessPdfs.render;
}

function catalogue(locale: BusinessLocale) {
  return locale === 'ar' ? ar : en;
}

/** Text made safe, its line breaks kept. */
function text(value: string): string {
  return escapeHtml(value).replace(/\r?\n/gu, '<br>');
}

/**
 * A number, reference or code that reads left to right inside Arabic too,
 * kept on one line; `wrap` for a long list or a link that may break.
 */
function ltr(value: string, wrap = false): string {
  return `<bdi dir="ltr"${wrap ? '' : ' class="nowrap"'}>${escapeHtml(value)}</bdi>`;
}

/** A catalogue string as HTML: its own words escaped, its `{{name}}`s replaced by the HTML given. */
function fillHtml(template: string, values: Readonly<Record<string, string>>): string {
  let out = '';
  let from = 0;
  for (const match of template.matchAll(/\{\{(\w+)\}\}/gu)) {
    out += escapeHtml(template.slice(from, match.index));
    out += values[match[1] ?? ''] ?? escapeHtml(match[0]);
    from = match.index + match[0].length;
  }
  return out + escapeHtml(template.slice(from));
}

class Formatter {
  readonly #locale: BusinessLocale;
  readonly #timeZone: string;

  constructor(locale: BusinessLocale, timeZone: string) {
    this.#locale = locale;
    this.#timeZone = timeZone;
  }

  /** The locale dates and numbers are written in: British English, or Arabic. */
  get #intl(): string {
    return this.#locale === 'ar' ? 'ar' : 'en-GB';
  }

  money(value: string, currency: string): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
      return `${value} ${currency}`;
    }
    try {
      return new Intl.NumberFormat(this.#intl, {
        style: 'currency',
        currency,
        maximumFractionDigits: 4,
      }).format(amount);
    } catch {
      return `${value} ${currency}`;
    }
  }

  quantity(value: string): string {
    const amount = Number(value);
    return Number.isFinite(amount)
      ? new Intl.NumberFormat(this.#intl, { maximumFractionDigits: 4 }).format(amount)
      : value;
  }

  /** Basis points as a percentage: 1450 → 14.5%. */
  percent(bp: number): string {
    return new Intl.NumberFormat(this.#intl, {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(bp / 10_000);
  }

  /** A calendar day, `YYYY-MM-DD`, the same wherever it is read. */
  day(value: string): string {
    return new Intl.DateTimeFormat(this.#intl, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
  }

  /** A moment's day in the company's time zone. */
  date(value: string): string {
    return new Intl.DateTimeFormat(this.#intl, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: this.#timeZone,
    }).format(new Date(value));
  }

  moment(value: string): string {
    return new Intl.DateTimeFormat(this.#intl, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: this.#timeZone,
    }).format(new Date(value));
  }

  time(value: string): string {
    return new Intl.DateTimeFormat(this.#intl, {
      timeStyle: 'short',
      timeZone: this.#timeZone,
    }).format(new Date(value));
  }

  number(value: number): string {
    return new Intl.NumberFormat(this.#intl).format(value);
  }
}

function addressLines(address: BusinessAddress | null, locale: BusinessLocale): string[] {
  if (address === null) {
    return [];
  }
  const cityLine = [address.city, address.region, address.postcode]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(locale === 'ar' ? '، ' : ', ');
  return [address.line1, address.line2, cityLine].filter(
    (part): part is string => part !== null && part !== '',
  );
}

class Page {
  readonly words: Words;
  readonly format: Formatter;
  readonly input: BusinessRenderInput;

  constructor(input: BusinessRenderInput) {
    this.input = input;
    this.words = wordsFor(input.locale);
    this.format = new Formatter(input.locale, input.timeZone);
  }

  get locale(): BusinessLocale {
    return this.input.locale;
  }

  /** The company's block: logo, name, address, tax number. */
  issuer(issuer: BusinessIssuer): string {
    // The look's logo; the company's own when the look names none.
    const source = this.input.look.logo ?? this.input.images.logo;
    const logo = source === null ? '' : safeImage(source, 'logo');
    return `<div class="issuer">${logo}<div class="issuer-text"><p class="company" dir="auto">${escapeHtml(issuer.name)}</p>${
      issuer.address === null || issuer.address.trim() === ''
        ? ''
        : `<p class="muted" dir="auto">${text(issuer.address)}</p>`
    }${
      issuer.taxReference === null || issuer.taxReference === ''
        ? ''
        : `<p class="muted">${escapeHtml(this.words.taxReference)}: ${ltr(issuer.taxReference)}</p>`
    }</div></div>`;
  }

  /** The document's name and dates, at the top's end. */
  identity(title: string, lines: readonly string[], stamp: string | null): string {
    return `<div class="identity"><h1>${title}</h1>${stamp === null ? '' : `<p class="stamp">${escapeHtml(stamp)}</p>`}${lines
      .map((line) => `<p>${line}</p>`)
      .join('')}</div>`;
  }

  /** The top of the first page: the company, then the document's name and its QR code. */
  head(issuer: BusinessIssuer, identity: string): string {
    return `<header class="head">${this.issuer(issuer)}<div class="head-end">${identity}${this.qr()}</div></header>`;
  }

  party(
    heading: string,
    name: string,
    address: BusinessAddress | null,
    extra: readonly string[],
  ): string {
    const lines = addressLines(address, this.locale).map(
      (line) => `<p dir="auto">${escapeHtml(line)}</p>`,
    );
    return `<section class="party"><h2>${escapeHtml(heading)}</h2><p class="strong" dir="auto">${escapeHtml(name)}</p>${lines.join('')}${extra
      .map((line) => `<p>${line}</p>`)
      .join('')}</section>`;
  }

  unit(unit: string): string {
    const units = catalogue(this.locale).inventory.unit as Readonly<Record<string, string>>;
    return units[unit] ?? unit;
  }

  /** A quote's or an invoice's lines, with the columns the lines need. */
  linesTable(
    lines: readonly BusinessLine[],
    currency: string,
    totals: BusinessTotals,
    after: readonly { label: string; value: string; strong?: boolean }[] = [],
  ): string {
    const { words, format } = this;
    const anyDiscount = lines.some((line) => line.discountBp !== 0);
    const anyTax = lines.some((line) => line.taxRateBp !== 0);
    const columns = 4 + (anyDiscount ? 1 : 0) + (anyTax ? 1 : 0);
    const head = [
      `<th class="desc">${escapeHtml(words.description)}</th>`,
      `<th class="num">${escapeHtml(words.quantity)}</th>`,
      `<th class="num">${escapeHtml(words.unitPrice)}</th>`,
      anyDiscount ? `<th class="num">${escapeHtml(words.discount)}</th>` : '',
      anyTax ? `<th class="num">${escapeHtml(words.taxRate)}</th>` : '',
      `<th class="num">${escapeHtml(words.total)}</th>`,
    ].join('');
    const body = lines
      .map(
        (line) =>
          `<tr><td dir="auto">${text(line.description)}</td><td class="num">${escapeHtml(format.quantity(line.quantity))} ${escapeHtml(this.unit(line.unit))}</td><td class="num">${escapeHtml(format.money(line.unitPrice, currency))}</td>${
            anyDiscount
              ? `<td class="num">${line.discountBp === 0 ? words.none : escapeHtml(format.percent(line.discountBp))}</td>`
              : ''
          }${
            anyTax
              ? `<td class="num">${line.taxRateBp === 0 ? words.none : escapeHtml(format.percent(line.taxRateBp))}</td>`
              : ''
          }<td class="num">${escapeHtml(format.money(line.total, currency))}</td></tr>`,
      )
      .join('');
    const sums: { label: string; value: string; strong?: boolean }[] = [
      ...(anyDiscount
        ? [
            { label: words.gross, value: format.money(totals.gross, currency) },
            { label: words.discountTotal, value: `−${format.money(totals.discount, currency)}` },
          ]
        : []),
      { label: words.net, value: format.money(totals.net, currency) },
      ...(anyTax ? [{ label: words.tax, value: format.money(totals.tax, currency) }] : []),
      { label: words.total, value: format.money(totals.total, currency), strong: true },
      ...after,
    ];
    return `<table class="lines"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${sums
      .map(
        (row) =>
          `<tr class="${row.strong === true ? 'grand' : ''}"><th scope="row" colspan="${String(columns - 1)}">${escapeHtml(row.label)}</th><td class="num">${escapeHtml(row.value)}</td></tr>`,
      )
      .join('')}</tfoot></table>`;
  }

  block(heading: string, body: string): string {
    return `<section class="block"><h2>${escapeHtml(heading)}</h2>${body}</section>`;
  }

  paragraph(value: string): string {
    return `<p class="prose" dir="auto">${text(value)}</p>`;
  }

  /** The QR code and, under it, what it opens. */
  qr(): string {
    const url = this.input.qrUrl;
    if (url === null) {
      return '';
    }
    const caption =
      this.input.qrOpensQuote === true ? this.words.scanQuote : this.words.scanDocument;
    return `<aside class="qr-box"><span class="qr">${qrSvg(url)}</span><p>${escapeHtml(caption)}</p></aside>`;
  }

  /** The company's own words at the end, as the browser-printed page has them. */
  footerNote(footer: string | null): string {
    return footer === null || footer.trim() === ''
      ? ''
      : `<p class="footer-note" dir="auto">${text(footer)}</p>`;
  }
}

/** A data URI for a picture, or nothing: only images the worker inlined are printed. */
function safeImage(source: string, className: string): string {
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(source)
    ? `<img class="${className}" src="${source}" alt="">`
    : '';
}

// ---------------------------------------------------------------------------
// The four layouts
// ---------------------------------------------------------------------------

function quoteBody(page: Page, data: QuoteDocumentData): { title: string; body: string } {
  const { words, format } = page;
  const title = fill(words.quote.title, { reference: data.reference });
  const lines = [
    `<span dir="auto">${escapeHtml(data.title)}</span>`,
    ...(data.issuedAt === null
      ? []
      : [escapeHtml(fill(words.quote.issuedOn, { date: format.date(data.issuedAt) }))]),
    ...(data.validUntil === null
      ? []
      : [escapeHtml(fill(words.quote.validUntil, { date: format.day(data.validUntil) }))]),
  ];
  const stamp = data.status === 'cancelled' ? words.quote.cancelled : null;
  const answer =
    data.answer === null
      ? ''
      : `<p class="answer">${escapeHtml(
          fill(data.answer.status === 'accepted' ? words.quote.accepted : words.quote.rejected, {
            date: format.moment(data.answer.at),
          }),
        )}${
          data.answer.name === null
            ? ''
            : ` ${escapeHtml(fill(words.quote.answeredBy, { name: data.answer.name }))}`
        }</p>`;
  const body = [
    page.head(
      data.issuer,
      page.identity(fillHtml(words.quote.title, { reference: ltr(data.reference) }), lines, stamp),
    ),
    `<div class="parties">${page.party(
      words.quote.for,
      data.customerName,
      data.customerAddress,
      data.contactName === null ? [] : [escapeHtml(data.contactName)],
    )}</div>`,
    data.introduction === null ? '' : page.paragraph(data.introduction),
    page.linesTable(data.lines, data.currencyCode, data.totals),
    data.terms === null ? '' : page.block(words.quote.terms, page.paragraph(data.terms)),
    answer,
    page.footerNote(data.footer),
  ].join('\n');
  return { title, body };
}

function invoiceBody(page: Page, data: InvoiceDocumentData): { title: string; body: string } {
  const { words, format } = page;
  const currency = data.currencyCode;
  const title = fill(words.invoice.title, { reference: data.reference });
  const lines = [
    ...(data.issueDate === null
      ? []
      : [escapeHtml(fill(words.invoice.issuedOn, { date: format.day(data.issueDate) }))]),
    ...(data.dueDate === null
      ? []
      : [escapeHtml(fill(words.invoice.dueOn, { date: format.day(data.dueDate) }))]),
  ];
  const stamp = data.status === 'void' ? words.invoice.void : null;
  const touched = data.amounts.credited !== '0' || data.amounts.allocated !== '0';
  const after = [
    ...(data.amounts.credited === '0'
      ? []
      : [
          {
            label: words.invoice.credited,
            value: `−${format.money(data.amounts.credited, currency)}`,
          },
        ]),
    ...(data.amounts.allocated === '0'
      ? []
      : [
          {
            label: words.invoice.paid,
            value: `−${format.money(data.amounts.allocated, currency)}`,
          },
        ]),
    ...(touched
      ? [
          {
            label: words.invoice.balance,
            value: format.money(data.amounts.balance, currency),
            strong: true,
          },
        ]
      : []),
  ];
  const history = (
    heading: string,
    rows: readonly { reference: string; date: string; amount: string }[],
  ) =>
    rows.length === 0
      ? ''
      : page.block(
          heading,
          `<table class="small"><thead><tr><th>${escapeHtml(words.invoice.reference)}</th><th>${escapeHtml(words.invoice.date)}</th><th class="num">${escapeHtml(words.invoice.amount)}</th></tr></thead><tbody>${rows
            .map(
              (row) =>
                `<tr><td>${ltr(row.reference)}</td><td>${escapeHtml(row.date)}</td><td class="num">${escapeHtml(row.amount)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        );
  const body = [
    page.head(
      data.issuer,
      page.identity(
        fillHtml(words.invoice.title, { reference: ltr(data.reference) }),
        lines,
        stamp,
      ),
    ),
    `<div class="parties">${page.party(
      words.invoice.billTo,
      data.customerName,
      data.customerAddress,
      data.contactName === null ? [] : [escapeHtml(data.contactName)],
    )}</div>`,
    page.linesTable(data.lines, currency, data.totals, after),
    data.notes === null ? '' : page.paragraph(data.notes),
    `<div class="columns">${history(
      words.invoice.creditNotes,
      data.creditNotes.map((note) => ({
        reference: note.reference,
        date: note.issueDate === null ? words.none : format.day(note.issueDate),
        amount: format.money(note.total, currency),
      })),
    )}${history(
      words.invoice.payments,
      data.payments.map((payment) => ({
        reference: payment.reference,
        date: format.day(payment.receivedOn),
        amount: format.money(payment.amount, currency),
      })),
    )}</div>`,
    data.paymentInstructions === null || data.paymentInstructions.trim() === ''
      ? ''
      : page.block(words.invoice.howToPay, page.paragraph(data.paymentInstructions)),
    page.footerNote(data.footer),
  ].join('\n');
  return { title, body };
}

function purchaseOrderBody(
  page: Page,
  data: PurchaseOrderDocumentData,
): { title: string; body: string } {
  const { words, format } = page;
  const currency = data.currencyCode;
  const title = fill(words.purchaseOrder.title, { reference: data.reference });
  const lines = [
    escapeHtml(fill(words.purchaseOrder.orderedOn, { date: format.date(data.orderedAt) })),
    ...(data.expectedDate === null
      ? []
      : [
          escapeHtml(fill(words.purchaseOrder.expectedOn, { date: format.day(data.expectedDate) })),
        ]),
  ];
  const stamp =
    data.status === 'draft'
      ? words.purchaseOrder.draft
      : data.status === 'cancelled'
        ? words.purchaseOrder.cancelled
        : null;
  const { supplier } = data;
  const supplierExtra = [
    ...(supplier.contactName === null ? [] : [escapeHtml(supplier.contactName)]),
    ...(supplier.email === null ? [] : [ltr(supplier.email)]),
    ...(supplier.phone === null ? [] : [ltr(supplier.phone)]),
    ...(supplier.taxReference === null
      ? []
      : [`${escapeHtml(words.taxReference)}: ${ltr(supplier.taxReference)}`]),
  ];
  const prices = data.totals !== null;
  const anyTax = data.lines.some((line) => line.taxRateBp !== 0);
  const columns = 2 + (prices ? 2 : 0) + (prices && anyTax ? 1 : 0);
  const head = [
    `<th class="desc">${escapeHtml(words.description)}</th>`,
    `<th class="num">${escapeHtml(words.quantity)}</th>`,
    prices ? `<th class="num">${escapeHtml(words.unitPrice)}</th>` : '',
    prices && anyTax ? `<th class="num">${escapeHtml(words.taxRate)}</th>` : '',
    prices ? `<th class="num">${escapeHtml(words.total)}</th>` : '',
  ].join('');
  const body = data.lines
    .map(
      (line) =>
        `<tr><td><span dir="auto">${text(line.description)}</span><span class="sku">${ltr(line.sku)}</span></td><td class="num">${escapeHtml(format.quantity(line.quantity))} ${escapeHtml(page.unit(line.unit))}</td>${
          prices
            ? `<td class="num">${line.unitPrice === null ? words.none : escapeHtml(format.money(line.unitPrice, currency))}</td>`
            : ''
        }${
          prices && anyTax
            ? `<td class="num">${line.taxRateBp === 0 ? words.none : escapeHtml(format.percent(line.taxRateBp))}</td>`
            : ''
        }${
          prices
            ? `<td class="num">${line.subtotal === null ? words.none : escapeHtml(format.money(line.subtotal, currency))}</td>`
            : ''
        }</tr>`,
    )
    .join('');
  const foot =
    data.totals === null
      ? ''
      : `<tfoot>${[
          { label: words.net, value: format.money(data.totals.subtotal, currency), strong: false },
          ...(anyTax
            ? [{ label: words.tax, value: format.money(data.totals.tax, currency), strong: false }]
            : []),
          { label: words.total, value: format.money(data.totals.total, currency), strong: true },
        ]
          .map(
            (row) =>
              `<tr class="${row.strong ? 'grand' : ''}"><th scope="row" colspan="${String(columns - 1)}">${escapeHtml(row.label)}</th><td class="num">${escapeHtml(row.value)}</td></tr>`,
          )
          .join('')}</tfoot>`;
  const html = [
    page.head(
      data.issuer,
      page.identity(
        fillHtml(words.purchaseOrder.title, { reference: ltr(data.reference) }),
        lines,
        stamp,
      ),
    ),
    `<div class="parties">${page.party(words.purchaseOrder.supplier, supplier.name, supplier.address, supplierExtra)}${
      data.deliverTo === null
        ? ''
        : `<section class="party"><h2>${escapeHtml(words.purchaseOrder.deliverTo)}</h2><p class="strong" dir="auto">${escapeHtml(data.deliverTo)}</p></section>`
    }</div>`,
    `<table class="lines"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`,
    data.notes === null ? '' : page.paragraph(data.notes),
    page.footerNote(data.footer),
  ].join('\n');
  return { title, body: html };
}

/** `2 h 05 min`, from milliseconds. */
function duration(page: Page, ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return fill(page.words.job.duration, {
    hours: page.format.number(Math.floor(minutes / 60)),
    minutes: page.format.number(minutes % 60),
  });
}

function pluralKey(locale: BusinessLocale, count: number): string {
  return new Intl.PluralRules(locale).select(count);
}

function jobReportBody(page: Page, data: JobReportData): { title: string; body: string } {
  const { words, format } = page;
  const job = words.job;
  const messages = catalogue(page.locale);
  const state = (messages.operations.state as Readonly<Record<string, string>>)[data.state];
  const priority = (messages.operations.priority as Readonly<Record<string, string>>)[
    data.priority
  ];
  const title = `${job.title} · ${data.reference}`;
  const identityLines = [
    `<span dir="auto">${escapeHtml(data.title)}</span>`,
    fillHtml(job.reference, { reference: ltr(data.reference) }),
  ];

  const facts: [string, string][] = [
    [job.jobType, escapeHtml(data.jobType)],
    [job.status, escapeHtml(state ?? data.state)],
    [job.priority, escapeHtml(priority ?? data.priority)],
    [job.created, escapeHtml(format.moment(data.createdAt))],
    ...(data.completedAt === null
      ? []
      : ([[job.completed, escapeHtml(format.moment(data.completedAt))]] as [string, string][])),
    ...(data.reviewedAt === null
      ? []
      : ([[job.reviewed, escapeHtml(format.moment(data.reviewedAt))]] as [string, string][])),
  ];
  const factsHtml = `<dl class="facts">${facts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd dir="auto">${value}</dd></div>`)
    .join('')}</dl>`;

  const { site, customer } = data;
  const location =
    site.location === null
      ? []
      : [
          escapeHtml(
            fill(job.coordinates, {
              latitude: site.location.latitude,
              longitude: site.location.longitude,
            }),
          ),
          `<span class="link">${fillHtml(job.map, {
            url: ltr(
              `https://www.google.com/maps/search/?api=1&query=${site.location.latitude},${site.location.longitude}`,
              true,
            ),
          })}</span>`,
        ];
  const parties = `<div class="parties">${page.party(job.customer, customer.name, null, [
    ...(customer.accountNumber === null
      ? []
      : [escapeHtml(fill(job.account, { number: customer.accountNumber }))]),
    ...(customer.phone === null ? [] : [ltr(customer.phone)]),
  ])}${page.party(job.site, site.name, site.address, location)}${
    data.siteContact === null
      ? ''
      : page.party(job.siteContact, data.siteContact.name, null, [
          ...(data.siteContact.phone === null ? [] : [ltr(data.siteContact.phone)]),
          ...(data.siteContact.email === null ? [] : [ltr(data.siteContact.email)]),
        ])
  }</div>`;

  const visits =
    data.visits.length === 0
      ? `<p class="muted">${escapeHtml(job.noVisits)}</p>`
      : `<table class="small"><thead><tr><th>${escapeHtml(job.planned)}</th><th>${escapeHtml(job.engineers)}</th><th>${escapeHtml(job.visitStatus)}</th></tr></thead><tbody>${data.visits
          .map(
            (visit) =>
              `<tr><td>${escapeHtml(format.moment(visit.startsAt))} – ${escapeHtml(format.time(visit.endsAt))}</td><td dir="auto">${escapeHtml(visit.engineers.join(', '))}</td><td>${escapeHtml(
                visit.completedAt === null
                  ? job.visitStatuses[visit.status]
                  : fill(job.visitDone, { date: format.moment(visit.completedAt) }),
              )}</td></tr>`,
          )
          .join('')}</tbody></table>`;

  const { times } = data;
  const onSite = times.onSiteMs + times.workMs + times.waitingMs;
  const anyTime = onSite + times.travelMs > 0 || times.arrivedAt !== null;
  const timeRows: [string, string][] = [
    ...(times.arrivedAt === null
      ? []
      : ([[job.arrived, format.moment(times.arrivedAt)]] as [string, string][])),
    ...(times.startedAt === null
      ? []
      : ([[job.started, format.moment(times.startedAt)]] as [string, string][])),
    ...(times.completedAt === null
      ? []
      : ([[job.finished, format.moment(times.completedAt)]] as [string, string][])),
    ...(times.travelMs > 0
      ? ([[job.travel, duration(page, times.travelMs)]] as [string, string][])
      : []),
    [job.onSite, duration(page, onSite)],
    ...(times.workMs > 0
      ? ([[job.working, duration(page, times.workMs)]] as [string, string][])
      : []),
    ...(times.waitingMs > 0
      ? ([[job.waiting, duration(page, times.waitingMs)]] as [string, string][])
      : []),
  ];
  const timeHtml = anyTime
    ? `<dl class="facts">${timeRows
        .map(
          ([label, value]) =>
            `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join('')}</dl>`
    : `<p class="muted">${escapeHtml(job.noTime)}</p>`;

  const parts =
    data.parts.length === 0
      ? `<p class="muted">${escapeHtml(job.noParts)}</p>`
      : `<table class="small"><thead><tr><th>${escapeHtml(job.part)}</th><th>${escapeHtml(job.sku)}</th><th class="num">${escapeHtml(words.quantity)}</th></tr></thead><tbody>${data.parts
          .map(
            (part) =>
              `<tr><td><span dir="auto">${escapeHtml(part.name)}</span>${
                part.serials.length === 0
                  ? ''
                  : `<span class="sku">${fillHtml(job.serials, { codes: ltr(part.serials.join(', '), true) })}</span>`
              }${
                part.batches.length === 0
                  ? ''
                  : `<span class="sku">${fillHtml(job.batches, { codes: ltr(part.batches.join(', '), true) })}</span>`
              }</td><td>${ltr(part.sku)}</td><td class="num">${escapeHtml(format.quantity(part.quantity))} ${escapeHtml(page.unit(part.unit))}</td></tr>`,
          )
          .join('')}</tbody></table>`;

  const forms =
    data.forms.length === 0
      ? `<p class="muted">${escapeHtml(job.noForms)}</p>`
      : `<table class="small"><thead><tr><th>${escapeHtml(job.form)}</th><th>${escapeHtml(job.submittedBy)}</th><th>${escapeHtml(job.submittedAt)}</th><th>${escapeHtml(job.formPdf)}</th></tr></thead><tbody>${data.forms
          .map(
            (form) =>
              `<tr><td dir="auto">${escapeHtml(form.title)}</td><td dir="auto">${escapeHtml(form.submittedBy ?? words.none)}</td><td>${
                form.submittedAt === null || form.status === 'missing'
                  ? escapeHtml(job.notSubmitted)
                  : escapeHtml(format.moment(form.submittedAt))
              }</td><td dir="auto">${form.documents.length === 0 ? words.none : escapeHtml(form.documents.join(', '))}</td></tr>`,
          )
          .join('')}</tbody></table><p class="muted small-print">${escapeHtml(job.formsNote)}</p>`;

  const checklist =
    data.checklist.length === 0
      ? ''
      : page.block(
          job.checklist,
          `<ul class="checks">${data.checklist
            .map(
              (item) =>
                `<li><span class="box${item.done ? ' on' : ''}">${item.done ? '✓' : ''}</span><span dir="auto">${escapeHtml(item.label)}</span></li>`,
            )
            .join('')}</ul>`,
        );

  const media = page.input.images.media;
  const photoGroup = (heading: string, stage: 'before' | 'after' | null) => {
    const figures = data.photos
      .filter((photo) => photo.stage === stage)
      .map((photo) => {
        const source = media[photo.fileId];
        const image = source === undefined ? '' : safeImage(source, 'photo');
        return image === ''
          ? ''
          : `<figure>${image}<figcaption dir="auto">${escapeHtml(photo.title)}</figcaption></figure>`;
      })
      .filter((figure) => figure !== '');
    return figures.length === 0
      ? ''
      : `<h3>${escapeHtml(heading)}</h3><div class="photos">${figures.join('')}</div>`;
  };
  const photoHtml = [
    photoGroup(job.before, 'before'),
    photoGroup(job.after, 'after'),
    photoGroup(job.other, null),
  ].join('');
  const morePhotos =
    data.morePhotos > 0
      ? `<p class="muted">${escapeHtml(
          fill(
            (job as unknown as Readonly<Record<string, string>>)[
              `morePhotos_${pluralKey(page.locale, data.morePhotos)}`
            ] ?? job.morePhotos_other,
            { count: format.number(data.morePhotos) },
          ),
        )}</p>`
      : '';
  const photos =
    photoHtml === '' && morePhotos === '' ? '' : page.block(job.photos, photoHtml + morePhotos);

  const { signoff } = data;
  let signoffHtml: string;
  if (signoff === null) {
    signoffHtml = `<p class="muted">${escapeHtml(job.noSignoff)}</p>`;
  } else if (signoff.unavailableReason !== null) {
    signoffHtml = `<p dir="auto">${escapeHtml(fill(job.notSigned, { reason: signoff.unavailableReason }))}</p><p class="muted">${escapeHtml(fill(job.signedAt, { date: format.moment(signoff.signedAt) }))}</p>`;
  } else {
    const signature =
      signoff.signatureFileId === null || media[signoff.signatureFileId] === undefined
        ? ''
        : safeImage(media[signoff.signatureFileId] ?? '', 'signature');
    const who =
      signoff.name === null
        ? ''
        : signoff.role === null
          ? signoff.name
          : fill(job.signedRole, { name: signoff.name, role: signoff.role });
    signoffHtml = `<div class="signoff">${signature}${
      who === '' ? '' : `<p dir="auto">${escapeHtml(fill(job.signedBy, { name: who }))}</p>`
    }<p class="muted">${escapeHtml(fill(job.signedAt, { date: format.moment(signoff.signedAt) }))}</p></div>`;
  }

  const notes =
    data.notes.length === 0
      ? ''
      : page.block(
          job.notes,
          data.notes
            .map(
              (note) =>
                `<div class="note"><p class="muted">${escapeHtml(note.author)} · ${escapeHtml(format.moment(note.at))}</p>${page.paragraph(note.body)}</div>`,
            )
            .join(''),
        );

  const body = [
    page.head(data.issuer, page.identity(escapeHtml(job.title), identityLines, null)),
    parties,
    factsHtml,
    data.description === null || data.description.trim() === ''
      ? ''
      : page.block(job.description, page.paragraph(data.description)),
    notes,
    page.block(job.visits, visits),
    page.block(job.time, timeHtml),
    page.block(job.parts, parts),
    page.block(job.forms, forms),
    checklist,
    photos,
    page.block(job.signoff, signoffHtml),
    page.footerNote(data.footer),
  ].join('\n');
  return { title, body };
}

function bodyOf(page: Page, data: BusinessDocumentData): { title: string; body: string } {
  switch (data.kind) {
    case 'quote':
      return quoteBody(page, data);
    case 'invoice':
      return invoiceBody(page, data);
    case 'purchase_order':
      return purchaseOrderBody(page, data);
    case 'job_report':
      return jobReportBody(page, data);
  }
}

function styles(look: DocumentLook, direction: 'ltr' | 'rtl'): string {
  const base = lookTemplates(look, { direction, margins: BUSINESS_MARGINS }).css;
  return `${base}
    .nowrap { white-space: nowrap; }
    h1 { font-size: 16pt; margin: 0 0 1.5mm; color: var(--brand); line-height: 1.2; }
    h2 { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--brand); margin: 0 0 1.5mm; }
    h3 { font-size: 9pt; margin: 3mm 0 1.5mm; color: #3b4450; }
    p { margin: 0; }
    .muted { color: #55606d; }
    .strong { font-weight: 700; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; padding-bottom: 4mm; border-bottom: 0.6mm solid var(--brand); margin-bottom: 6mm; }
    .issuer { display: flex; gap: 4mm; align-items: flex-start; min-width: 0; flex: 1 1 55%; }
    .issuer .logo { max-height: 18mm; max-width: 45mm; object-fit: contain; }
    .issuer-text { display: flex; flex-direction: column; gap: 0.5mm; }
    .company { font-size: 12pt; font-weight: 700; }
    .identity { text-align: end; display: flex; flex-direction: column; align-items: flex-end; gap: 0.5mm; }
    .stamp { display: inline-block; border: 0.35mm solid #b42318; color: #b42318; border-radius: 1mm; padding: 0.5mm 2mm; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 1mm; }
    .parties { display: flex; flex-wrap: wrap; gap: 6mm 10mm; margin-bottom: 6mm; }
    .party { min-width: 50mm; flex: 1 1 0; display: flex; flex-direction: column; gap: 0.5mm; }
    .prose { margin: 0 0 4mm; white-space: normal; }
    table { width: 100%; border-collapse: collapse; }
    table.lines { margin: 0 0 6mm; }
    table.lines thead th { background: var(--brand); color: #ffffff; font-weight: 600; font-size: 8.5pt; padding: 1.8mm 2mm; text-align: start; }
    table.lines thead th.num, table.small thead th.num { text-align: end; }
    table.lines tbody td { padding: 2mm; border-bottom: 0.25mm solid #d5dae0; vertical-align: top; }
    table.lines tbody tr:nth-child(even) td { background: #f6f7f9; }
    table.lines tfoot th { text-align: end; font-weight: 500; padding: 1.2mm 2mm; }
    table.lines tfoot td { padding: 1.2mm 2mm; }
    table.lines tfoot tr:first-child th, table.lines tfoot tr:first-child td { padding-top: 3mm; }
    table.lines tfoot tr.grand th, table.lines tfoot tr.grand td { font-weight: 700; font-size: 10.5pt; border-top: 0.4mm solid var(--brand); }
    table thead { display: table-header-group; }
    table tr { break-inside: avoid; }
    th.num, td.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
    th.desc { width: 46%; }
    table.small { margin: 0 0 2mm; font-size: 8.5pt; }
    table.small th { text-align: start; font-weight: 600; color: #3b4450; border-bottom: 0.4mm solid var(--brand); padding: 1.2mm 1.6mm; }
    table.small td { border-bottom: 0.25mm solid #d5dae0; padding: 1.2mm 1.6mm; vertical-align: top; }
    .sku { display: block; font-size: 7.5pt; color: #55606d; }
    .block { margin: 0 0 5mm; break-inside: auto; }
    .block > h2 { break-after: avoid; }
    .columns { display: flex; gap: 8mm; }
    .columns > .block { flex: 1 1 0; }
    .answer { font-weight: 600; margin: 0 0 4mm; }
    .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm 6mm; margin: 0 0 5mm; }
    .facts div { display: flex; flex-direction: column; }
    .facts dt { font-size: 7.5pt; color: #55606d; text-transform: uppercase; letter-spacing: 0.03em; }
    .facts dd { margin: 0; font-weight: 600; }
    .link { overflow-wrap: anywhere; font-size: 8pt; }
    .checks { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 8mm; }
    .checks li { display: flex; gap: 2mm; align-items: center; margin: 0 0 1mm; break-inside: avoid; }
    .box { display: inline-flex; width: 3.6mm; height: 3.6mm; border: 0.3mm solid #3b4450; border-radius: 0.5mm; align-items: center; justify-content: center; font-size: 7pt; flex: none; }
    .box.on { background: var(--brand); border-color: var(--brand); color: #ffffff; }
    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
    .photos figure { margin: 0; break-inside: avoid; }
    .photos img { width: 100%; height: 42mm; object-fit: cover; border-radius: 1mm; display: block; }
    .photos figcaption { font-size: 7.5pt; color: #55606d; margin-top: 0.8mm; }
    .signoff { break-inside: avoid; }
    .signoff .signature { max-height: 28mm; max-width: 80mm; display: block; margin-bottom: 1.5mm; border-bottom: 0.3mm solid #9aa3ad; }
    .note { margin: 0 0 2mm; }
    .small-print { font-size: 7.5pt; }
    .head-end { display: flex; gap: 5mm; align-items: flex-start; justify-content: flex-end; flex: 0 1 45%; }
    .qr-box { display: flex; flex-direction: column; align-items: center; gap: 1mm; width: 26mm; flex: none; }
    .qr { width: 22mm; height: 22mm; display: block; }
    .qr svg { width: 100%; height: 100%; display: block; }
    .qr-box p { font-size: 6.5pt; line-height: 1.25; color: #55606d; text-align: center; }
    .footer-note { margin-top: 4mm; font-size: 8pt; color: #55606d; border-top: 0.25mm solid #d5dae0; padding-top: 2mm; }
  `;
}

/** A business record as one printable HTML page, with its running header and footer. */
export function renderBusinessDocumentHtml(input: BusinessRenderInput): RenderedBusinessDocument {
  const page = new Page(input);
  const direction = input.locale === 'ar' ? 'rtl' : 'ltr';
  const { title, body } = bodyOf(page, input.data);
  const look: DocumentLook = {
    ...input.look,
    header: input.look.header ?? { start: input.data.issuer.name, end: title },
    footer: input.look.footer ?? {
      start: input.data.reference,
      end: wordsFor(input.locale).page,
    },
  };
  const templates = lookTemplates(look, { direction, margins: BUSINESS_MARGINS });
  const html = `<!doctype html><html lang="${input.locale}" dir="${direction}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${styles(look, direction)}</style></head><body><main>${body}</main></body></html>`;
  return {
    html,
    headerHtml: templates.headerHtml,
    footerHtml: templates.footerHtml,
    margins: BUSINESS_MARGINS,
    title,
  };
}
