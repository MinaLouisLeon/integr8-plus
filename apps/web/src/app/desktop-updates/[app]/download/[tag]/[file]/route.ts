import { desktopUpdateFeed, isAppName } from '~/lib/desktop-updates';

/**
 * An update's file, passed through from a private repository's release.
 *
 * Only used when `GITHUB_RELEASES_TOKEN` is set: the feed then points the
 * manifest's links here, because an installed app has no GitHub credentials.
 * With a public repository the manifest links straight to GitHub and this
 * answers 404. Only assets of that app's own releases are served; the file is
 * checked by the app against the release's signature either way.
 */
export const dynamic = 'force-dynamic';

interface Params {
  app: string;
  tag: string;
  file: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<Params> },
): Promise<Response> {
  const { app, tag, file } = await params;
  const feed = desktopUpdateFeed();
  if (!isAppName(app) || feed === undefined) {
    return new Response(null, { status: 404 });
  }
  try {
    // Tags and asset names are plain ASCII (collect-bundles.mjs names them),
    // so nothing here needs decoding.
    const response = await feed.download(app, tag, file);
    return response ?? new Response(null, { status: 404 });
  } catch (error) {
    console.error('desktop update download', app, tag, file, error);
    return new Response(null, { status: 502 });
  }
}
