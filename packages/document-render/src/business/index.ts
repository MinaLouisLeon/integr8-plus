// The document look (`./look.js`) is a temporary copy of the shared one and is
// deliberately not exported: the shared look is.
export {
  type BusinessAddress,
  type BusinessDocumentData,
  type BusinessDocumentKind,
  type BusinessImages,
  type BusinessIssuer,
  type BusinessLine,
  type BusinessLocale,
  type BusinessRenderInput,
  type BusinessTotals,
  type InvoiceDocumentData,
  JOB_REPORT_MAX_PHOTOS,
  type JobReportData,
  type JobReportPhoto,
  type PurchaseOrderDocumentData,
  type QuoteDocumentData,
} from './model.js';
export {
  BUSINESS_MARGINS,
  type RenderedBusinessDocument,
  renderBusinessDocumentHtml,
} from './render.js';
export {
  sampleDocument,
  sampleInvoice,
  sampleJobReport,
  samplePurchaseOrder,
  sampleQuote,
} from './samples.js';
