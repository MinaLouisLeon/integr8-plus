import { NextResponse } from 'next/server';
import { forwardedClientHeaders } from '~/lib/api';
import { desktopUpdateFeed } from '~/lib/desktop-updates';
import { apiBaseUrl } from '~/lib/platform-api';
import { lookupFormsAi, lookupInstallers } from '~/lib/release-lookup';

/**
 * The staff apps' downloads, for the dashboard's Downloads page: the staff
 * desktop app and Integr8 Forms for AI.
 *
 * Staff only. The release list is this server's (its repository and token are
 * server settings), so the page asks here with its platform access token, and
 * the token is checked by the API (`/v1/platform/me`) before anything is
 * listed: the web server never decides on its own who is staff.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json({ error: { code: 'no_session' } }, { status: 401 });
  }

  const me = await fetch(`${apiBaseUrl()}/v1/platform/me`, {
    headers: {
      authorization,
      ...forwardedClientHeaders(request),
      'x-client-app': 'web',
      'x-client-version': process.env.NEXT_PUBLIC_APP_VERSION ?? '1.1.0',
    },
    cache: 'no-store',
  }).catch(() => undefined);
  if (me === undefined) {
    return NextResponse.json({ error: { code: 'api_unreachable' } }, { status: 502 });
  }
  if (!me.ok) {
    return NextResponse.json(
      { error: { code: 'no_session' } },
      { status: me.status === 403 ? 403 : 401 },
    );
  }

  const feed = desktopUpdateFeed();
  const [staff, formsAi] = await Promise.all([
    lookupInstallers(feed, 'staff'),
    lookupFormsAi(feed),
  ]);
  return NextResponse.json({ staff, formsAi }, { headers: { 'cache-control': 'no-store' } });
}
