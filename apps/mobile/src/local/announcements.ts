import { dismissAnnouncement as dismissOnPhone } from '@integr8/offline';
import { localData } from './local-data';

/**
 * Hides an announcement on this phone (P15). Recorded in the phone's own
 * database, so it stays hidden offline and after a restart; the server is not
 * told, because closing a banner is this person's business. A new reminder is
 * a new announcement, and shows again.
 */
export async function dismissAnnouncement(id: string): Promise<void> {
  const status = localData.status();
  if (status.phase !== 'open') {
    return;
  }
  await status.db.write(['meta'], (sql) => dismissOnPhone(sql, id));
}
