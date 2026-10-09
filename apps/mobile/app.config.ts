import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import {
  type CompanyBuild,
  companyIdentifiers,
  parseCompanyBuild,
} from './src/lib/company-config.ts';

/**
 * The app's config, resolved when Expo reads it.
 *
 * Without `company.json` this is the generic Integr8 Plus app, exactly as the
 * old `app.json` described it. With one — written by CI from the public brand
 * endpoint before `eas build`, never committed — it is that company's own app:
 * its name, its icon, its colours and its own store identifiers, with the
 * company baked into `extra.company` so the first screen wears the brand before
 * the phone has made a single request.
 *
 * Everything to do with EAS stays the same for every company: one project
 * keeps the credentials per app identifier, one update URL serves every build,
 * and CI picks the update channel with `eas build --channel production-<slug>`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EAS_PROJECT_ID = 'b950cc9e-9e26-477a-905f-4c216767fde4';

function readCompany(): CompanyBuild | undefined {
  const file = join(here, 'company.json');
  if (!existsSync(file)) {
    return undefined;
  }
  const company = parseCompanyBuild(JSON.parse(readFileSync(file, 'utf8')));
  if (company === undefined) {
    throw new Error(`${file} does not describe a company: it needs at least a slug and a name.`);
  }
  return company;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const company = readCompany();
  const identifiers = company === undefined ? undefined : companyIdentifiers(company.slug);
  // Downloaded by CI next to company.json; the generic app has no icon key, as before.
  const icon = join(here, 'company', 'icon.png');
  const hasIcon = company !== undefined && existsSync(icon);
  const background = company?.shellColour ?? company?.brandColour ?? '#ffffff';

  return {
    ...config,
    name: company?.name ?? 'Integr8 Plus',
    slug: identifiers?.slug ?? 'integr8-plus',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: identifiers?.scheme ?? 'integr8',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ...(hasIcon ? { icon: './company/icon.png' } : {}),
    ...(company === undefined ? {} : { splash: { backgroundColor: background } }),
    ios: {
      supportsTablet: true,
      bundleIdentifier: identifiers?.iosBundleIdentifier ?? 'com.integr8.plus',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: identifiers?.androidPackage ?? 'com.integr8.plus',
      edgeToEdgeEnabled: true,
      ...(hasIcon
        ? { adaptiveIcon: { foregroundImage: './company/icon.png', backgroundColor: background } }
        : {}),
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-localization',
      [
        'expo-sqlite',
        {
          useSQLCipher: true,
          enableFTS: true,
        },
      ],
      'expo-background-task',
      [
        'expo-camera',
        {
          cameraPermission:
            'Integr8 Plus uses the camera to photograph work and to scan barcodes into forms.',
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission: 'Integr8 Plus lets you add photos from this phone to a form.',
          cameraPermission: 'Integr8 Plus uses the camera to photograph work for a form.',
          microphonePermission: false,
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Integr8 Plus records where a form was submitted, and fills location questions.',
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
        },
      ],
      [
        'expo-local-authentication',
        {
          // Prose, not a layout direction: the phone is left unattended.
          faceIDPermission:
            // eslint-disable-next-line no-restricted-syntax
            'Integr8 Plus uses Face ID to unlock, so customers’ details stay private on a phone left unattended.',
        },
      ],
      [
        'expo-notifications',
        {
          defaultChannel: 'jobs',
        },
      ],
      'expo-updates',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      ...config.extra,
      eas: {
        projectId: EAS_PROJECT_ID,
      },
      ...(company === undefined ? {} : { company }),
    },
    runtimeVersion: {
      policy: 'fingerprint',
    },
    updates: {
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
  };
};
