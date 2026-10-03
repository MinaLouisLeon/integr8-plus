import type { SqlConnection } from '../sql.js';

/**
 * Time on a phone that may be wrong by hours.
 *
 * The device clock is used for exactly two things: how long ago something
 * happened on the phone (which it measures well even when its wall time is
 * wrong), and when to try again. Order comes from the outbox's sequence, never
 * from timestamps. Every server response carries the server's time; the gap
 * between that and the device's clock is kept as `clock_offset_ms`, and anything
 * compared with server data — the retention window, "last synced" — uses the
 * corrected time.
 */

export interface DeviceClock {
  now(): Date;
}

export const systemClock: DeviceClock = { now: () => new Date() };

/** Server time minus device time, measured at the midpoint of a request. */
export function measureOffset(serverTime: string, sentAt: Date, receivedAt: Date): number {
  const midpoint = sentAt.getTime() + (receivedAt.getTime() - sentAt.getTime()) / 2;
  return Math.round(Date.parse(serverTime) - midpoint);
}

export async function clockOffset(sql: SqlConnection): Promise<number> {
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'clock_offset_ms'`,
  );
  const parsed = Number(row?.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function saveClockOffset(sql: SqlConnection, offsetMs: number): Promise<void> {
  await sql.run(
    `insert into meta (key, value) values ('clock_offset_ms', ?)
     on conflict (key) do update set value = excluded.value`,
    [String(offsetMs)],
  );
}

export function serverNow(device: Date, offsetMs: number): Date {
  return new Date(device.getTime() + offsetMs);
}
