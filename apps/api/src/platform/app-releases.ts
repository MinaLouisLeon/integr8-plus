import {
  DesktopUpdateFeed,
  type FormsAiLookup,
  lookupFormsAi,
  lookupInstallers,
  type ReleaseLookup,
} from '@integr8/releases';

/**
 * The apps' releases, as the API needs them (P42).
 *
 * Two questions. Which staff downloads exist, for the staff app's Downloads
 * list. And whether a company's own desktop app has been built, because an
 * owner is invited only once there is an app to sign in to: the office works
 * in its company's desktop app, and there is no web workspace to fall back on.
 *
 * The same pattern as the other outside services: an interface, a recording
 * stand-in, and the real adapter, chosen by `APP_RELEASES`. The release list
 * itself is `@integr8/releases`, which the public site's update feed uses too.
 */

/** Whether a company's own desktop app exists, as far as the releases say. */
export type CompanyAppState =
  /** A published release for the company with a desktop installer in it. */
  | 'built'
  /** No such release yet. */
  | 'not_built'
  /** GitHub could not be asked just now. */
  | 'unavailable'
  /** This deployment reads no releases (`APP_RELEASES=off`): nothing waits for one. */
  | 'not_checked';

export interface StaffDownloads {
  staff: ReleaseLookup;
  formsAi: FormsAiLookup;
}

export interface AppReleases {
  readonly provider: string;
  /** Never throws: GitHub being down is an answer. */
  companyDesktopApp(slug: string): Promise<CompanyAppState>;
  /** Never throws, like the lookups it is made of. */
  staffDownloads(): Promise<StaffDownloads>;
}

/** Reads nothing. Development and `APP_RELEASES=off`; production refuses it. */
export class NoAppReleases implements AppReleases {
  readonly provider = 'off';

  companyDesktopApp(): Promise<CompanyAppState> {
    return Promise.resolve('not_checked');
  }

  staffDownloads(): Promise<StaffDownloads> {
    return Promise.resolve({ staff: { status: 'none' }, formsAi: { status: 'none' } });
  }
}

/** Answers from what a test says has been built. */
export class RecordingAppReleases implements AppReleases {
  readonly provider = 'recording';
  readonly built = new Set<string>();
  unavailable = false;

  companyDesktopApp(slug: string): Promise<CompanyAppState> {
    if (this.unavailable) {
      return Promise.resolve('unavailable');
    }
    return Promise.resolve(this.built.has(slug) ? 'built' : 'not_built');
  }

  staffDownloads(): Promise<StaffDownloads> {
    return Promise.resolve({ staff: { status: 'none' }, formsAi: { status: 'none' } });
  }
}

export class GitHubAppReleases implements AppReleases {
  readonly provider = 'github';
  readonly #feed: DesktopUpdateFeed;
  /**
   * The public site's address, which private-repository download links pass
   * through (`/desktop-updates/<app>/download/…`). The staff app opens those
   * links itself, so they must be whole addresses, not relative ones.
   */
  readonly #origin: string;

  constructor(options: {
    repository: string;
    token?: string | undefined;
    origin: string;
    fetch?: typeof fetch;
  }) {
    this.#feed = new DesktopUpdateFeed({
      repository: options.repository,
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#origin = options.origin;
  }

  async companyDesktopApp(slug: string): Promise<CompanyAppState> {
    const found = await lookupInstallers(this.#feed, slug, this.#origin);
    if (found.status === 'unavailable') {
      return 'unavailable';
    }
    // A company's release carries its phone app too; only a desktop installer
    // means the office has something to install.
    return found.status === 'found' &&
      found.release.installers.some((installer) => installer.platform !== 'android')
      ? 'built'
      : 'not_built';
  }

  async staffDownloads(): Promise<StaffDownloads> {
    const [staff, formsAi] = await Promise.all([
      lookupInstallers(this.#feed, 'staff', this.#origin),
      lookupFormsAi(this.#feed, this.#origin),
    ]);
    return { staff, formsAi };
  }
}
