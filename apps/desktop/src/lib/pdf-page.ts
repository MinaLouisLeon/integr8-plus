import type { PdfPageRenderer } from '@integr8/operations-dom';

/**
 * One page of a PDF drawn on a canvas, for placing an uploaded PDF's QR code
 * (0075). The same pdf.js and bundled worker as the PDF viewer, loaded only
 * when first asked; no script in the PDF runs.
 */
export const renderPdfPage: PdfPageRenderer = async (bytes, page, canvas, width) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const document = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
  try {
    const number = page === 'last' ? document.numPages : Math.min(page, document.numPages);
    const loaded = await document.getPage(number);
    const unscaled = loaded.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = loaded.getViewport({ scale: (width / unscaled.width) * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (context !== null) {
      await loaded.render({ canvasContext: context, viewport }).promise;
    }
    return { pages: document.numPages, aspect: unscaled.width / unscaled.height };
  } finally {
    await document.destroy();
  }
};
