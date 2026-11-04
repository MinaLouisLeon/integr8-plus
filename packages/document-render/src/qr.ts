import { encode } from 'uqr';

/**
 * A QR code as one SVG path, black on white, with the quiet zone the standard
 * asks for, at error correction level Q: it still reads with a quarter of it
 * scratched or smudged, which a sheet that lives on a clipboard needs. The same
 * drawing the asset tags use.
 */
/** The same code as a grid of dark modules, quiet zone included, for drawing it elsewhere (0075). */
export function qrMatrix(text: string): { size: number; dark: (x: number, y: number) => boolean } {
  const qr = encode(text, { ecc: 'Q', border: 4 });
  return { size: qr.size, dark: (x, y) => qr.data[y]?.[x] === true };
}

export function qrSvg(text: string): string {
  const qr = encode(text, { ecc: 'Q', border: 4 });
  let path = '';
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        path += `M${String(x)} ${String(y)}h1v1h-1z`;
      }
    });
  });
  const size = String(qr.size);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}
