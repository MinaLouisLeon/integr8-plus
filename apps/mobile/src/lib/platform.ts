import type { StoredTokens, TokenStore } from '@integr8/core';
import * as SecureStore from 'expo-secure-store';
import { revive, serialise, type SerialisedTokens } from './token-serialisation';

/**
 * Tokens in the device's secure storage.
 *
 * `expo-secure-store` is the Keychain on iOS and EncryptedSharedPreferences
 * backed by the Keystore on Android. Neither is readable by another app, and
 * neither survives an uninstall — which is what "never in local storage" means
 * on a phone.
 *
 * This matters more here than anywhere else in the product. A phone is the
 * device most likely to be lost, and it is the one holding a seven-day offline
 * grant.
 */

const KEY = 'integr8.session';

export class SecureTokenStore implements TokenStore {
  async read(): Promise<StoredTokens | undefined> {
    const stored = await SecureStore.getItemAsync(KEY);
    if (stored === null) {
      return undefined;
    }

    try {
      return revive(JSON.parse(stored) as SerialisedTokens);
    } catch {
      // Corrupt, or written by an older build with a different shape. Treat it
      // as signed out rather than crashing on launch: the person signs in again
      // and the entry is replaced.
      await this.clear();
      return undefined;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await SecureStore.setItemAsync(KEY, JSON.stringify(serialise(tokens)), {
      // The session is needed the moment the app opens, including after a
      // restart and before the first unlock of the day. Requiring the device to
      // have been unlocked once since boot is the strictest setting that still
      // lets an engineer open the app in a van at 6am.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  }
}
