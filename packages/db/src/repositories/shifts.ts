import { type UserId, toUserId } from '@integr8/core';
import type { Selectable } from 'kysely';
import type { DeviceLocation, ShiftsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * An engineer's working day (P14): clocked in and out on the phone, at the times
 * the phone recorded, with where it was if it could tell.
 *
 * Migration 0013 keeps one open shift per person, refuses a shift longer than a
 * week, and refuses changing a shift's person or start, or its end once it has one.
 * Clocking in and out are both safe to repeat: a phone resending either finds what
 * it already wrote.
 */

export interface Shift {
  id: string;
  userId: UserId;
  startedAt: Date;
  endedAt: Date | null;
  startLocation: DeviceLocation | null;
  endLocation: DeviceLocation | null;
}

export type ClockInResult =
  | { outcome: 'started'; shift: Shift }
  /** This shift was already started: a resend. */
  | { outcome: 'already'; shift: Shift }
  /** Another shift is still open for this person. */
  | { outcome: 'open_elsewhere'; open: Shift }
  /** The id belongs to someone else's shift. */
  | { outcome: 'not_yours' };

export type ClockOutResult =
  | { outcome: 'ended'; shift: Shift }
  | { outcome: 'already'; shift: Shift }
  | { outcome: 'not_found' }
  /** Clocked out before it started: a clock that went backwards. */
  | { outcome: 'before_start'; shift: Shift };

export class ShiftsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #shifts() {
    return this.db.selectFrom('shifts').where('shifts.tenant_id', '=', this.tenantId);
  }

  async find(shiftId: string): Promise<Shift | undefined> {
    const row = await this.#shifts().selectAll().where('id', '=', shiftId).executeTakeFirst();
    return row === undefined ? undefined : toShift(row);
  }

  async openFor(userId: UserId | string): Promise<Shift | undefined> {
    const row = await this.#shifts()
      .selectAll()
      .where('user_id', '=', toUserId(userId))
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toShift(row);
  }

  async clockIn(input: {
    id: string;
    userId: UserId | string;
    startedAt: Date;
    location: DeviceLocation | null;
  }): Promise<ClockInResult> {
    const existing = await this.find(input.id);
    if (existing !== undefined) {
      return existing.userId === toUserId(input.userId)
        ? { outcome: 'already', shift: existing }
        : { outcome: 'not_yours' };
    }
    const open = await this.openFor(input.userId);
    if (open !== undefined) {
      return { outcome: 'open_elsewhere', open };
    }
    const row = await this.db
      .insertInto('shifts')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        started_at: input.startedAt,
        start_location: input.location,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { outcome: 'started', shift: toShift(row) };
  }

  async clockOut(input: {
    id: string;
    userId: UserId | string;
    endedAt: Date;
    location: DeviceLocation | null;
  }): Promise<ClockOutResult> {
    const shift = await this.find(input.id);
    if (shift?.userId !== toUserId(input.userId)) {
      return { outcome: 'not_found' };
    }
    if (shift.endedAt !== null) {
      return { outcome: 'already', shift };
    }
    if (input.endedAt < shift.startedAt) {
      return { outcome: 'before_start', shift };
    }
    const row = await this.db
      .updateTable('shifts')
      .set({ ended_at: input.endedAt, end_location: input.location })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.id)
      .where('ended_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      const now = await this.find(input.id);
      return now === undefined ? { outcome: 'not_found' } : { outcome: 'already', shift: now };
    }
    return { outcome: 'ended', shift: toShift(row) };
  }

  /** Shifts that overlap a window, newest first; for one person or everyone. */
  async list(query: { from: Date; to: Date; userId?: UserId | string }): Promise<Shift[]> {
    let select = this.#shifts()
      .selectAll()
      .where('started_at', '<', query.to)
      .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', query.from)]));
    if (query.userId !== undefined) {
      select = select.where('user_id', '=', toUserId(query.userId));
    }
    return (await select.orderBy('started_at', 'desc').limit(2000).execute()).map(toShift);
  }
}

function toShift(row: Selectable<ShiftsTable>): Shift {
  return {
    id: row.id,
    userId: toUserId(row.user_id),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startLocation: row.start_location,
    endLocation: row.end_location,
  };
}
