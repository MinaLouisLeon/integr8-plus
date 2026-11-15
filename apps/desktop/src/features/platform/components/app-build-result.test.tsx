import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type AppBuild, AppBuildResult } from './app-build-result';

/**
 * What the dashboard says after asking for a company's app build (P15): where
 * to watch it, or how to start it by hand when this server cannot.
 */

function render(build: AppBuild, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <AppBuildResult build={build} slug="acme" />
    </I18nextProvider>,
  );
}

const RUNS = 'https://github.com/o/r/actions/workflows/build-company-apps.yml';

describe('the build result', () => {
  it('links the run itself when GitHub named it', () => {
    const html = render({
      status: 'started',
      runsUrl: RUNS,
      runUrl: 'https://github.com/o/r/actions/runs/7',
      message: null,
    });
    expect(html).toContain('Build started on GitHub.');
    expect(html).toContain('href="https://github.com/o/r/actions/runs/7"');
    expect(html).toContain('Watch the build');
  });

  it('links the workflow’s runs otherwise', () => {
    const html = render({ status: 'started', runsUrl: RUNS, runUrl: null, message: null });
    expect(html).toContain(`href="${RUNS}"`);
    expect(html).toContain('See the builds');
  });

  it('says how to build by hand when the server does not start builds', () => {
    const build: AppBuild = {
      status: 'not_configured',
      runsUrl: null,
      runUrl: null,
      message: null,
    };
    expect(render(build)).toContain('with the short name acme');
    expect(render(build, 'ar')).toContain('acme');
    expect(render(build, 'ar')).toContain('GitHub Actions');
  });

  it('passes on why GitHub refused', () => {
    expect(
      render({
        status: 'failed',
        runsUrl: null,
        runUrl: null,
        message: 'GitHub answered 401.',
      }),
    ).toContain('The build could not be started: GitHub answered 401.');
  });
});
