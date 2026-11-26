import { desktopUpdateFeed, isAppName } from '@integr8/releases';
import {
  DOWNLOAD_LIMIT,
  MISS_LIMIT,
  tooManyRequests,
  updateRouteLimiter,
  visitorAddress,
} from '~/lib/request-limit';

/**
 * An update's file, passed through from a private repository's release.
 *
 * Only used when `GITHUB_RELEASES_TOKEN` is set: the feed then points the
 * manifest's links here, because an installed app has no GitHub credentials.
 * With a public repository the manifest links straight to GitHub and this
 * answers 404. Only assets of that app's own releases are served; the file is
 * checked by the app against the release's signature either way.
 *
 * Each pass-through costs this server's bandwidth and the token's hourly
 * GitHub allowance, so one address may fetch the same file a few times an
 * hour, which an updater never needs more than once; and a file that is not
 * there counts against the address like a name nobody has
 * (`~/lib/request-limit`).
 */
export const dynamic = 'force-dynamic';

interface Params {
  app: string;
  tag: string;
  file: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<Params> },
): Promise<Response> {
  const { app, tag, file } = await params;
  const feed = desktopUpdateFeed();
  if (!isAppName(app) || feed === undefined) {
    return new Response(null, { status: 404 });
  }
  const address = visitorAddress(request);
  const missKey = address === null ? null : `miss:${address}`;
  if (address !== null && missKey !== null) {
    const blocked = updateRouteLimiter.blockedFor(missKey);
    if (blocked !== null) {
      return tooManyRequests(blocked);
    }
    const over = updateRouteLimiter.hit(
      `download:${address}:${app}/${tag}/${file}`,
      DOWNLOAD_LIMIT,
    );
    if (over !== null) {
      return tooManyRequests(over);
    }
  }
  try {
    // Tags and asset names are plain ASCII (collect-bundles.mjs names them),
    // so nothing here needs decoding.
    const response = await feed.download(app, tag, file);
    if (response !== undefined) {
      return response;
    }
    const over = missKey === null ? null : updateRouteLimiter.hit(missKey, MISS_LIMIT);
    return over === null ? new Response(null, { status: 404 }) : tooManyRequests(over);
  } catch (error) {
    console.error('desktop update download', app, tag, file, error);
    return new Response(null, { status: 502 });
  }
}
