import { desktopUpdateFeed, isAppName, publicOrigin } from '~/lib/desktop-updates';

/**
 * The desktop updater's question: is there something newer for this app?
 *
 * The address is the Tauri updater's endpoint template,
 * `/desktop-updates/<app>/{{target}}/{{arch}}/{{current_version}}`, stamped
 * into each build. The answer is the app's newest release manifest whatever
 * the platform and version asked about: the manifest lists every platform,
 * and the updater itself compares versions and checks the signature. 204 is
 * the updater's "nothing new", which is also the answer when this server has
 * no repository configured or the app has no release with a manifest yet.
 */
export const dynamic = 'force-dynamic';

interface Params {
  app: string;
  target: string;
  arch: string;
  version: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<Params> },
): Promise<Response> {
  const { app } = await params;
  if (!isAppName(app)) {
    return new Response(null, { status: 404 });
  }
  const feed = desktopUpdateFeed();
  if (feed === undefined) {
    return new Response(null, { status: 204 });
  }
  try {
    const manifest = await feed.manifest(app, publicOrigin(request));
    if (manifest === undefined) {
      return new Response(null, { status: 204 });
    }
    return Response.json(manifest, {
      headers: { 'cache-control': 'public, max-age=300' },
    });
  } catch (error) {
    console.error('desktop update feed', app, error);
    return Response.json(
      { error: { code: 'update_feed_unavailable' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
