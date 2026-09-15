import type { TFunction } from '@integr8/i18n';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { session } from '~/lib/session';
import { localData } from './local-data';

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

/**
 * Asks once for permission and registers this phone for the signed-in person.
 * Quietly does nothing on a simulator, in a build without an EAS project, when
 * permission is refused, or offline — the next launch tries again.
 */
export async function registerForPush(names: ChannelNames): Promise<void> {
  try {
    await createChannels(names);
    const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
      ?.projectId;
    if (!Device.isDevice || projectId === undefined || projectId === PLACEHOLDER_PROJECT) {
      return;
    }
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) {
      return;
    }
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await sendToken(token);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'push' } });
  }
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

async function openFromNotification(response: Notifications.NotificationResponse): Promise<void> {
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
  const received = Notifications.addNotificationReceivedListener(() => {
    void localData.sync('change');
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
