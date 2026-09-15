import type { ByteTransport, FileSource, RandomBytes, SyncConditions } from '@integr8/offline';
import { fetch as expoFetch } from 'expo/fetch';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as Network from 'expo-network';

/**
 * What the sync engine needs from the phone itself (P12): randomness for change
 * ids, the bytes of captured files, a way to send bytes to storage, and whether
 * it is online and how much battery is left. Everything else about sync is in
 * `@integr8/offline`, where it is tested against a real server.
 */

export const random: RandomBytes = (length) => Crypto.getRandomBytes(length);

/** Reads a stored file a part at a time, so a large video is never all in memory. */
export const deviceFiles: FileSource = {
  exists: (path) => Promise.resolve(new File(path).exists),
  read: (path, offset, length) => {
    const handle = new File(path).open();
    try {
      handle.offset = offset;
      return Promise.resolve(handle.readBytes(length));
    } finally {
      handle.close();
    }
  },
};

export const deviceTransport: ByteTransport = {
  put: async (url, headers, body) => {
    const response = await expoFetch(url, {
      method: 'PUT',
      headers: { ...headers },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    return { status: response.status };
  },
};

export async function deviceConditions(): Promise<SyncConditions> {
  const [network, level, state] = await Promise.all([
    Network.getNetworkStateAsync(),
    Battery.getBatteryLevelAsync().catch(() => -1),
    Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
  ]);
  return {
    online: network.isConnected !== false && network.isInternetReachable !== false,
    networkType: network.type ?? null,
    batteryLevel: level < 0 ? null : level,
    charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
  };
}
