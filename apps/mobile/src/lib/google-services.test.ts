import { describe, expect, it } from 'vitest';
import { googleServicesDecision, googleServicesPackages } from './google-services';

/** A Firebase project's file after adding the generic app and one company's. */
const file = JSON.stringify({
  project_info: { project_number: '123', project_id: 'integr8-plus' },
  client: [
    { client_info: { android_client_info: { package_name: 'com.integr8.plus' } } },
    { client_info: { android_client_info: { package_name: 'com.integr8.plus.acme_2' } } },
  ],
  configuration_version: '1',
});

describe('google-services.json in an Android build', () => {
  it('lists the package ids the file has an app for', () => {
    expect(googleServicesPackages(file)).toEqual(['com.integr8.plus', 'com.integr8.plus.acme_2']);
    expect(googleServicesPackages('not json')).toEqual([]);
    expect(googleServicesPackages('{}')).toEqual([]);
  });

  it('goes into a build whose package is in it', () => {
    expect(
      googleServicesDecision('/eas/google-services.json', file, 'com.integr8.plus.acme_2'),
    ).toEqual({
      use: true,
    });
  });

  it('is left out, with the reason, for a company not yet in Firebase, so the build still succeeds', () => {
    const decision = googleServicesDecision(
      '/eas/google-services.json',
      file,
      'com.integr8.plus.globex',
    );
    expect(decision).toMatchObject({ use: false, reason: 'package_missing' });
    expect(decision.use ? '' : decision.message).toContain('com.integr8.plus.globex');
  });

  it('is left out when no file was given, or the one given cannot be read', () => {
    expect(googleServicesDecision(undefined, undefined, 'com.integr8.plus')).toEqual({
      use: false,
      reason: 'not_set',
    });
    expect(googleServicesDecision('/missing.json', undefined, 'com.integr8.plus')).toMatchObject({
      use: false,
      reason: 'unreadable',
    });
  });
});
