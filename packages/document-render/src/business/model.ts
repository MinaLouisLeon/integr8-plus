import type { DocumentLook } from './look.js';

/**
 * What a business PDF is made from: a snapshot of the record as the person who
 * asked for it saw it, taken by the API when they asked and handed to the
 * worker with the job. Plain data: amounts are decimal strings as the API
 * gives them, dates are ISO strings, pictures are named by id and become data
 * URIs only when the worker prints.
 *
 * The four layouts carry what the browser-printed ones carry (the React
 * documents in `@integr8/operations-dom`), so a PDF from the server and a page
 * printed from the browser say the same things.
 */

export type BusinessDocumentKind = 'quote' | 'invoice' | 'purchase_order' | 'job_report';
export type BusinessLocale = 'en' | 'ar';

export interface BusinessAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region?: string | null;
  postcode: string | null;
  countryCode?: string | null;
}

/** The company issuing the document, as its invoices name it where it has said. */
export interface BusinessIssuer {
  name: string;
  /** Free text, line breaks kept. */
  address: string | null;
  taxReference: string | null;
}

/** One line of a quote or an invoice. */
export interface BusinessLine {
  description: string;
  quantity: string;
  /** An inventory unit key: `each`, `m`, `kg`… */
  unit: string;
  unitPrice: string;
  discountBp: number;
  taxRateBp: number;
  total: string;
}

export interface BusinessTotals {
  gross: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
}

interface Common {
  /** The record's number: `QT-000123`, `INV-000123`, `PO-000123`, `WO-000123`. */
  reference: string;
  issuer: BusinessIssuer;
  /** The company's own words at the foot of every page; null for none. */
  footer: string | null;
}

export interface QuoteDocumentData extends Common {
  kind: 'quote';
  title: string;
  status: string;
  issuedAt: string | null;
  validUntil: string | null;
  customerName: string;
  customerAddress: BusinessAddress | null;
  contactName: string | null;
  introduction: string | null;
  terms: string | null;
  currencyCode: string;
  lines: readonly BusinessLine[];
  totals: BusinessTotals;
  answer: { status: 'accepted' | 'rejected'; at: string; name: string | null } | null;
}

export interface InvoiceDocumentData extends Common {
  kind: 'invoice';
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  customerName: string;
  customerAddress: BusinessAddress | null;
  contactName: string | null;
  notes: string | null;
  paymentInstructions: string | null;
  currencyCode: string;
  lines: readonly BusinessLine[];
  totals: BusinessTotals;
  amounts: { credited: string; allocated: string; balance: string };
  creditNotes: readonly { reference: string; issueDate: string | null; total: string }[];
  payments: readonly { reference: string; receivedOn: string; amount: string }[];
}

export interface PurchaseOrderDocumentData extends Common {
  kind: 'purchase_order';
  status: string;
  orderedAt: string;
  expectedDate: string | null;
  supplier: {
    name: string;
    address: BusinessAddress | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    taxReference: string | null;
  };
  deliverTo: string | null;
  notes: string | null;
  currencyCode: string;
  lines: readonly {
    description: string;
    sku: string;
    quantity: string;
    unit: string;
    unitPrice: string | null;
    taxRateBp: number;
    subtotal: string | null;
  }[];
  totals: { subtotal: string; tax: string; total: string } | null;
}

export interface JobReportPhoto {
  /** The media id of the picture in the company's bucket. */
  fileId: string;
  title: string;
  stage: 'before' | 'after' | null;
}

export interface JobReportData extends Common {
  kind: 'job_report';
  title: string;
  state: string;
  priority: string;
  jobType: string;
  createdAt: string;
  completedAt: string | null;
  reviewedAt: string | null;
  description: string | null;
  customer: { name: string; accountNumber: string | null; phone: string | null };
  site: {
    name: string;
    address: BusinessAddress;
    location: { latitude: string; longitude: string } | null;
  };
  siteContact: { name: string; phone: string | null; email: string | null } | null;
  /** Comments the job's people marked for the customer. */
  notes: readonly { author: string; at: string; body: string }[];
  visits: readonly {
    startsAt: string;
    endsAt: string;
    status: 'planned' | 'done' | 'cancelled';
    engineers: readonly string[];
    completedAt: string | null;
  }[];
  /** From the job's state changes, added up the way every screen adds them (`jobTimes`). */
  times: {
    arrivedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    travelMs: number;
    onSiteMs: number;
    workMs: number;
    waitingMs: number;
  };
  parts: readonly {
    name: string;
    sku: string;
    quantity: string;
    unit: string;
    serials: readonly string[];
    batches: readonly string[];
  }[];
  forms: readonly {
    title: string;
    status: 'submitted' | 'draft' | 'reopened' | 'missing';
    submittedBy: string | null;
    submittedAt: string | null;
    /** The PDFs made from the submission, by their titles. */
    documents: readonly string[];
  }[];
  checklist: readonly { label: string; done: boolean }[];
  /** At most {@link JOB_REPORT_MAX_PHOTOS}; `morePhotos` says how many were left out. */
  photos: readonly JobReportPhoto[];
  morePhotos: number;
  signoff: {
    signedAt: string;
    name: string | null;
    role: string | null;
    /** The signature's media id, when the customer signed. */
    signatureFileId: string | null;
    unavailableReason: string | null;
  } | null;
}

/** Photos printed in one job report: enough for any job, small enough to email. */
export const JOB_REPORT_MAX_PHOTOS = 60;

export type BusinessDocumentData =
  QuoteDocumentData | InvoiceDocumentData | PurchaseOrderDocumentData | JobReportData;

/** The pictures the worker read from the company's bucket, by media id, as data URIs. */
export interface BusinessImages {
  logo: string | null;
  media: Readonly<Record<string, string>>;
}

export interface BusinessRenderInput {
  data: BusinessDocumentData;
  locale: BusinessLocale;
  /** The company's time zone, for moments. */
  timeZone: string;
  /** What the QR code opens; null for no code. */
  qrUrl: string | null;
  /** Whether the QR code opens the customer's quote page rather than the PDF's own. */
  qrOpensQuote?: boolean;
  images: BusinessImages;
  look: DocumentLook;
}
