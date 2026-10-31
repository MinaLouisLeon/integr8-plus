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

/**
 * The product's version, from the root package.json: the one number a release
 * bumps. The phone sends it as `x-client-version` and Sentry files crashes
 * under it, so a copy kept here went stale (1.1.0 while the product was 1.2.1).
 * EAS uploads the whole workspace, so the file is there on the build server.
 */
function productVersion(): string {
  const root = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof root.version !== 'string' || root.version === '') {
    throw new Error('The root package.json has no version.');
  }
  return root.version;
}
const EAS_PROJECT_ID = 'b950cc9e-9e26-477a-905f-4c216767fde4';

/** Why the phone may use the microphone: the assistant's spoken questions, and nothing else. */
const VOICE_MICROPHONE =
  'Integr8 Plus uses the microphone, only when you tap it, to hear a question you speak to the assistant.';

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
    version: productVersion(),
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
      // Edge to edge is always on from SDK 58 (Android 16 requires it), so there is no switch.
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
          // The camera never records sound, but the plugin that asks for the
          // microphone must not be the one that removes it: see VOICE below.
          microphonePermission: VOICE_MICROPHONE,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission: 'Integr8 Plus lets you add photos from this phone to a form.',
          cameraPermission: 'Integr8 Plus uses the camera to photograph work for a form.',
          // `false` here would block RECORD_AUDIO for every package on Android,
          // the assistant's spoken questions included.
          microphonePermission: VOICE_MICROPHONE,
        },
      ],
      [
        // The assistant's spoken questions (docs/ai §10.5): the phone's own
        // recogniser, so the app asks for the microphone and, on iOS, speech
        // recognition. Audio goes to the phone's speech service, never to us.
        'expo-speech-recognition',
        {
          microphonePermission: VOICE_MICROPHONE,
          speechRecognitionPermission:
            'Integr8 Plus uses speech recognition, only when you tap the microphone, to turn your spoken question for the assistant into text.',
          androidSpeechServicePackages: [
            'com.google.android.tts',
            'com.google.android.googlequicksearchbox',
          ],
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
