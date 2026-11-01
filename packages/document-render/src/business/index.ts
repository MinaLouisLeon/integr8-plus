// The look (brand colour, font, header and footer) is the shared one, `../look.js`.
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
