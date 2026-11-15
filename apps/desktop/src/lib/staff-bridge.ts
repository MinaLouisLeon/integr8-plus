/**
 * What the company workspace needs to know about staff, without carrying any
 * staff code (P42).
 *
 * The staff dashboard is loaded lazily and never by a company's build, so the
 * company frame cannot import it. Instead the staff session registers itself
 * here when it loads, and the frame asks: where to go when the company session
 * ends (back to the dashboard while staff are signed in, else sign-in), and how
 * to leave the company the banner says staff are inside.
 */

export interface StaffBridge {
  /** The dashboard's address while a staff session is held; null otherwise. */
  home(): string | null;
  /** Whether staff are working inside a company from the dashboard. */
  insideCompany(): boolean;
  /** Ends the grant and the company session; resolves to the dashboard address to go to. */
  leaveCompany(): Promise<string>;
}

let bridge: StaffBridge | undefined;

export function registerStaffBridge(next: StaffBridge): void {
  bridge = next;
}

export function staffBridge(): StaffBridge | undefined {
  return bridge;
}

/** Where the window goes when the company session ends. */
export function afterCompanySignOut(): string {
  return bridge?.home() ?? '/sign-in';
}
