/**
 * Correcting a site's access notes on the phone (P12): what the form starts
 * from, and which fields the engineer actually changed.
 *
 * Only changed fields are sent. Two engineers offline at the same site, one
 * fixing the gate code and the other the parking, then both arrive cleanly; a
 * field sent unchanged would be part of every conflict for no reason.
 */

export type AccessField = 'gateCode' | 'parking' | 'askFor' | 'hazards' | 'notes';

/** In the order the form asks: safety first, then what is needed at the gate. */
export const ACCESS_FIELDS: readonly AccessField[] = [
  'hazards',
  'gateCode',
  'askFor',
  'parking',
  'notes',
];

/** The longest each field may be, as the API takes it (`accessInputSchema`). */
export const ACCESS_MAX_LENGTH: Readonly<Record<AccessField, number>> = {
  gateCode: 200,
  parking: 2000,
  askFor: 500,
  hazards: 4000,
  notes: 4000,
};

export type AccessValuesNow = Record<AccessField, string | null>;
export type AccessDraft = Record<AccessField, string>;

/** The form's starting text: what the phone has, with none as empty. */
export function accessDraft(current: AccessValuesNow): AccessDraft {
  return {
    gateCode: current.gateCode ?? '',
    parking: current.parking ?? '',
    askFor: current.askFor ?? '',
    hazards: current.hazards ?? '',
    notes: current.notes ?? '',
  };
}

/**
 * The fields that differ from what the phone has, trimmed, an emptied field as
 * none — the same reading the server gives them, so what the engineer sees
 * after saving is what the office will see.
 */
export function accessChanges(
  current: AccessValuesNow,
  draft: AccessDraft,
): Partial<Record<AccessField, string | null>> {
  const changes: Partial<Record<AccessField, string | null>> = {};
  for (const field of ACCESS_FIELDS) {
    const before = current[field]?.trim() ?? '';
    const after = draft[field].trim();
    if (after !== before) {
      changes[field] = after === '' ? null : after;
    }
  }
  return changes;
}
