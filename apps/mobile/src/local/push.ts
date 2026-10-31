import type { TFunction } from '@integr8/i18n';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { deviceLocale } from '~/lib/preferences';
import { session } from '~/lib/session';
import { localData } from './local-data';
import { isOffline, isOnline } from './online';

/**
 * Push notifications (P14): a new job, a job moved, an urgent callout.
 *
 * The phone registers its Expo push token with the API for the signed-in
 * session; the API sends through Expo's push service, which reaches FCM and
 * APNs. A notification is only a nudge: the job itself arrives by sync, which a
 * notification starts, so what the engineer opens is always the phone's own copy.
 *
 * Android shows notifications on two channels the person can tune separately in
 * the system settings: ordinary job changes, and urgent callouts, which make a
 * sound and appear over what they are doing.
 */

const PLACEHOLDER_PROJECT = '00000000-0000-0000-0000-000000000000';

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

export interface ChannelNames {
  jobs: string;
  urgent: string;
}

async function createChannels(names: ChannelNames): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await Notifications.setNotificationChannelAsync('jobs', {
    name: names.jobs,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync('urgent', {
    name: names.urgent,
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

let registered: string | undefined;

type PushStep = 'channels' | 'permission' | 'token' | 'register';

/**
 * A registration that failed, told to whoever can fix it and not to the
 * engineer, who can do nothing about it: Sentry, when the build has a DSN,
 * tagged with the step, and the device log either way.
 *
 * `token` failing on Android almost always means the build had no
 * `google-services.json` for its package (setup guide, Stage 8), and it was
 * once swallowed without a trace: the phone simply never heard about a job.
 */
function reportPushFailure(step: PushStep, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Push registration failed at ${step} on ${Platform.OS}: ${message}`);
  Sentry.captureException(error, { tags: { area: 'push', step, platform: Platform.OS } });
}

/** Runs one step, reporting a failure as that step's; resolves undefined when it failed. */
async function step<T>(name: PushStep, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    reportPushFailure(name, error);
    return undefined;
  }
}

/**
 * Asks once for permission and registers this phone for the signed-in person.
 * Quietly does nothing on a simulator, in a build without an EAS project, when
 * permission is refused, or offline — the next launch tries again. A failure
 * is reported, never shown: the work on the phone goes on without push.
 */
export async function registerForPush(names: ChannelNames): Promise<void> {
  // A channel that could not be made still lets the phone register: Android
  // then shows its notifications on the default channel.
  await step('channels', () => createChannels(names));
  const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
    ?.projectId;
  if (!Device.isDevice || projectId === undefined || projectId === PLACEHOLDER_PROJECT) {
    return;
  }
  const granted = await step('permission', async () => {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    return permission.granted;
  });
  // Offline is not a failure: the token needs Expo's servers, and the next
  // launch tries again.
  if (granted !== true || !(await isOnline())) {
    return;
  }
  const token = await step(
    'token',
    async () => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  );
  if (token === undefined) {
    return;
  }
  await step('register', async () => {
    try {
      await sendToken(token);
    } catch (error) {
      if (!isOffline(error)) {
        throw error;
      }
    }
  });
}

async function sendToken(token: string): Promise<void> {
  if (!(await session().canReachApi())) {
    return;
  }
  await session().client.PUT('/v1/me/push-device', {
    body: {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceLabel: Device.deviceName ?? Device.modelName ?? null,
      // The language the app is showing, the same one it chose at start-up, so
      // notifications arrive in it. Sent every time the phone registers, which
      // is every launch: a phone switched to another language says so on the
      // next one.
      locale: deviceLocale(),
    },
  });
  registered = token;
}

/** Stops notifications to this phone, while the session can still say so. Sign-out does it on the server too. */
export async function unregisterForPush(): Promise<void> {
  const token = registered;
  registered = undefined;
  if (token === undefined) {
    return;
  }
  await session()
    .client.POST('/v1/me/push-device/unregister', { body: { token } })
    .catch(() => undefined);
}

function jobOf(data: unknown): string | undefined {
  const id = (data as { workOrderId?: unknown } | null)?.workOrderId;
  return typeof id === 'string' ? id : undefined;
}

/** A warranty alert the phone raised itself (`warranty-alerts.ts`): it names an asset, and needs no sync. */
function warrantyAlertOf(data: unknown): { assetId?: string } | undefined {
  const content = data as { kind?: unknown; assetId?: unknown } | null;
  if (content?.kind !== 'warranty') {
    return undefined;
  }
  return typeof content.assetId === 'string' ? { assetId: content.assetId } : {};
}

async function openFromNotification(response: Notifications.NotificationResponse): Promise<void> {
  const warranty = warrantyAlertOf(response.notification.request.content.data);
  if (warranty !== undefined) {
    if (warranty.assetId !== undefined) {
      router.push({ pathname: '/assets/[id]', params: { id: warranty.assetId } });
    }
    return;
  }
  const workOrderId = jobOf(response.notification.request.content.data);
  // Fetch first, briefly: a new job is not on the phone until sync brings it.
  await Promise.race([
    localData.sync('change'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (workOrderId !== undefined) {
    router.push({ pathname: '/jobs/[id]', params: { id: workOrderId } });
  }
}

/**
 * Listens while the app runs: a notification arriving starts a sync, tapping
 * one opens its job — including the tap that launched the app.
 */
export function listenForPush(names: ChannelNames): () => void {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    if (warrantyAlertOf(notification.request.content.data) === undefined) {
      void localData.sync('change');
    }
  });
  const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
    void openFromNotification(response);
  });
  const tokens = Notifications.addPushTokenListener(() => {
    void registerForPush(names);
  });
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response !== null) {
      void openFromNotification(response);
      Notifications.clearLastNotificationResponse();
    }
  });
  return () => {
    received.remove();
    tapped.remove();
    tokens.remove();
  };
}

/** What the two Android channels are called in the system settings, in the app's language. */
export function channelNames(t: TFunction): ChannelNames {
  return { jobs: t('mobile.push.channelJobs'), urgent: t('mobile.push.channelUrgent') };
}
