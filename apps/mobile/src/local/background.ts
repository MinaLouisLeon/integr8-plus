import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { localData } from './local-data';

/**
 * Sync while the app is closed (P12).
 *
 * The operating system decides when: it batches background work to spare the
 * battery, waits for a connection, and runs the task at most every fifteen
 * minutes or so — on iOS, when it judges the app worth waking. This is the
 * safety net for work left unsent when the engineer pocketed the phone; the app
 * still syncs the moment it comes back to the foreground or regains signal.
 *
 * The task must be defined when the JavaScript bundle loads, before anything
 * renders, which is why this module is imported by the root layout.
 */

export const BACKGROUND_SYNC_TASK = 'integr8.sync';

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    await localData.sync('background');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      return;
    }
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 15 });
  } catch {
    // Not available here (Expo Go, a restricted device): foreground sync still runs.
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    }
  } catch {
    // Nothing registered.
  }
}
