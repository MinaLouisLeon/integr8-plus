/**
 * Whether a link stays on the company's website.
 *
 * The welcome screen shows the site in a WebView and hands anything that leaves
 * it to the system browser. "Leaves it" is a different origin: scheme, host and
 * port. Written by hand rather than with `URL`, whose `origin` React Native's
 * polyfill does not reliably provide.
 */
export function originOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#]+)/iu.exec(url.trim());
  if (match === null) {
    return null;
  }
  const scheme = (match[1] ?? '').toLowerCase();
  let host = (match[2] ?? '').toLowerCase();
  // Strip credentials, then a default port.
  host = host.slice(host.indexOf('@') + 1);
  const defaultPort = scheme === 'https' ? ':443' : ':80';
  if (host.endsWith(defaultPort)) {
    host = host.slice(0, -defaultPort.length);
  }
  return `${scheme}://${host}`;
}

export function sameOrigin(a: string, b: string): boolean {
  const left = originOf(a);
  return left !== null && left === originOf(b);
}
