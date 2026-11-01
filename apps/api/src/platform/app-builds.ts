/**
 * Starting one company's own app build from the dashboard.
 *
 * The build itself is the `build-company-apps.yml` workflow on GitHub: desktop
 * installers on GitHub's machines, phone apps on Expo. This only asks GitHub
 * to run it for one company, the way somebody would from the Actions tab.
 * GitHub answers as soon as the run is queued, so a slow build never holds up
 * the request; how the run went is on GitHub, not here.
 */

export const COMPANY_APPS_WORKFLOW = 'build-company-apps.yml';

/** What came of asking for a build. */
export type AppBuildStart =
  | {
      status: 'started';
      /** The workflow's list of runs, where this one is at the top. */
      runsUrl: string;
      /** The run itself, when GitHub said which one it started. */
      runUrl: string | null;
    }
  /** This deployment has no way to start builds (APP_BUILDS=off). */
  | { status: 'not_configured' }
  | { status: 'failed'; message: string };

export interface AppBuildTrigger {
  readonly provider: string;
  /** Never throws: a build that could not be started is an answer, not an error. */
  start(companySlug: string): Promise<AppBuildStart>;
}

/** Keeps what it was asked for; starts nothing. Development, tests, and APP_BUILDS=off. */
export class RecordingAppBuildTrigger implements AppBuildTrigger {
  readonly provider = 'recording';
  readonly requested: string[] = [];

  start(companySlug: string): Promise<AppBuildStart> {
    this.requested.push(companySlug);
    return Promise.resolve({ status: 'not_configured' });
  }
}

export class GitHubAppBuildTrigger implements AppBuildTrigger {
  readonly provider = 'github';
  readonly #token: string;
  readonly #repository: string;
  readonly #ref: string;
  readonly #fetch: typeof fetch;

  constructor(options: { token: string; repository: string; ref: string; fetch?: typeof fetch }) {
    this.#token = options.token;
    this.#repository = options.repository;
    this.#ref = options.ref;
    this.#fetch = options.fetch ?? fetch;
  }

  async start(companySlug: string): Promise<AppBuildStart> {
    // GitHub names the run it started only when asked to (`return_run_details`,
    // answered with 200 and the run's address). Asked without it, or by a
    // GitHub that does not know the flag, it answers 204 and the dashboard
    // links to the workflow's runs instead.
    let response = await this.#dispatch(companySlug, true);
    if (response instanceof Response && response.status === 422) {
      const refusal = await describeRefusal(response.clone());
      if (refusal.includes('return_run_details')) {
        response = await this.#dispatch(companySlug, false);
      }
    }
    if (!(response instanceof Response)) {
      return response;
    }

    const runsUrl = `https://github.com/${this.#repository}/actions/workflows/${COMPANY_APPS_WORKFLOW}`;
    if (response.status === 204) {
      return { status: 'started', runsUrl, runUrl: null };
    }
    if (response.status === 200) {
      return { status: 'started', runsUrl, runUrl: await runAddress(response) };
    }
    return { status: 'failed', message: await describeRefusal(response) };
  }

  async #dispatch(
    companySlug: string,
    withRunDetails: boolean,
  ): Promise<Response | { status: 'failed'; message: string }> {
    const url = `https://api.github.com/repos/${this.#repository}/actions/workflows/${COMPANY_APPS_WORKFLOW}/dispatches`;
    try {
      return await this.#fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
          'user-agent': 'integr8-plus-api',
          'x-github-api-version': '2022-11-28',
        },
        // Everything else is left to the workflow's defaults: the version from
        // package.json, the API from PUBLIC_API_URL, the platforms from the
        // repository variables.
        body: JSON.stringify({
          ref: this.#ref,
          inputs: { company: companySlug },
          ...(withRunDetails ? { return_run_details: true } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return {
        status: 'failed',
        message: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/** The run's page on github.com from a dispatch answer, if it names one. */
async function runAddress(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { html_url?: unknown };
    return typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/')
      ? body.html_url
      : null;
  } catch {
    return null;
  }
}

async function describeRefusal(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') {
      detail = body.message;
    }
  } catch {
    // Not JSON; the status says enough.
  }
  const hint =
    response.status === 401
      ? ' The GITHUB_BUILD_TOKEN is wrong or has expired.'
      : response.status === 403 || response.status === 404
        ? ' Check that GITHUB_BUILD_TOKEN can run workflows ("Actions: read and write") on GITHUB_BUILD_REPOSITORY, and that the workflow is on GITHUB_BUILD_REF.'
        : '';
  return `GitHub answered ${String(response.status)}${detail === '' ? '' : ` (${detail})`}.${hint}`;
}
