/**
 * A one-page PDF naming a test document's values (P43), for
 * `seed_shared_documents`: something real to upload into the register, made
 * here without a library. Plain Helvetica, so only printable ASCII is drawn;
 * anything else becomes `?` (the values themselves are stored as typed).
 */

const ascii = (value: string) =>
  value
    .replace(/[^\x20-\x7e]/gu, '?')
    .replace(/\\/gu, '\\\\')
    .replace(/\(/gu, '\\(')
    .replace(/\)/gu, '\\)');

export function testPdf(title: string, lines: readonly string[]): Uint8Array {
  const text = [
    'BT',
    '/F1 20 Tf',
    '56 780 Td',
    `(${ascii(title).slice(0, 80)}) Tj`,
    '/F1 12 Tf',
    '0 -16 TL',
    'T*',
    '(Integr8 test document, made by the developer MCP server.) Tj',
    'T*',
    ...lines.slice(0, 40).flatMap((line) => ['T*', `(${ascii(line).slice(0, 100)}) Tj`]),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(text, 'latin1'))} >>\nstream\n${text}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
