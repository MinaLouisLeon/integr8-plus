import { apiErrorMessage, useTranslation } from '@integr8/i18n';
import { useState } from 'react';
import { buttonClass, Field, inputClass } from './ui.js';

export interface Location {
  latitude: number;
  longitude: number;
}

type GeocodeStatus = 'pending' | 'found' | 'not_found' | 'failed' | 'manual';

/**
 * Google Maps at a point, for checking where a site is.
 *
 * A link rather than a map drawn on the screen: a drawn map needs a tile
 * service with its own account and keys for production, and the office only
 * needs to see the place, which Google Maps does better in its own tab.
 */
export function googleMapsUrl(location: Location): string {
  return `https://www.google.com/maps/search/?api=1&query=${String(location.latitude)},${String(location.longitude)}`;
}

/**
 * Where a site is, and how a person corrects it.
 *
 * The address is geocoded by the server. When that is wrong or impossible —
 * a new estate, a gate round the back — a person types the coordinates (from
 * Google Maps: right-click the spot, click the numbers to copy them), or
 * stands on the spot and uses their device's location. A position placed by
 * hand is kept until the address changes. "Open in Google Maps" shows where
 * the saved position is.
 */
export function SiteLocation({
  location,
  status,
  accuracy,
  editable,
  onSave,
}: {
  location: Location | null;
  status: GeocodeStatus;
  accuracy: string | null;
  editable: boolean;
  onSave: (location: Location | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ latitude: string; longitude: string }>({
    latitude: location === null ? '' : String(location.latitude),
    longitude: location === null ? '' : String(location.longitude),
  });
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const latitude = Number(draft.latitude);
  const longitude = Number(draft.longitude);
  const valid =
    draft.latitude !== '' &&
    draft.longitude !== '' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  const changed = valid && (location?.latitude !== latitude || location.longitude !== longitude);

  const place = (next: Location) => {
    setDraft({ latitude: next.latitude.toFixed(6), longitude: next.longitude.toFixed(6) });
  };

  const save = (next: Location | null) => {
    setSaving(true);
    setProblem(undefined);
    onSave(next)
      .catch((error: unknown) => setProblem(apiErrorMessage(error, t)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <p
        role="status"
        className={`text-sm ${status === 'not_found' || status === 'failed' ? 'text-danger' : 'text-content-muted'}`}
      >
        {status === 'found'
          ? t('operations.location.found', { accuracy: accuracy ?? '' })
          : t(`operations.location.${status}`)}
      </p>

      {location === null ? null : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-content">
          <span>
            <span className="text-content-muted">{t('operations.location.coordinates')}: </span>
            {/* Numbers read left to right in both languages. */}
            <span dir="ltr" className="font-mono">
              {location.latitude}, {location.longitude}
            </span>
          </span>
          <a
            className="text-accent underline-offset-4 hover:underline"
            href={googleMapsUrl(location)}
            target="_blank"
            rel="noreferrer"
          >
            {t('operations.location.openMap')}
          </a>
        </p>
      )}

      {editable ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('operations.location.latitude')}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                dir="ltr"
                className={inputClass}
                value={draft.latitude}
                onChange={(event) => setDraft({ ...draft, latitude: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('operations.location.longitude')}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                dir="ltr"
                className={inputClass}
                value={draft.longitude}
                onChange={(event) => setDraft({ ...draft, longitude: event.target.value })}
              />
            )}
          </Field>
        </div>
      ) : null}

      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={locating || typeof navigator === 'undefined' || !('geolocation' in navigator)}
            aria-busy={locating}
            onClick={() => {
              setLocating(true);
              setProblem(undefined);
              navigator.geolocation.getCurrentPosition(
                (position) => {
                  setLocating(false);
                  place({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                  });
                },
                () => {
                  setLocating(false);
                  setProblem(t('operations.location.locationUnavailable'));
                },
                { enableHighAccuracy: true, timeout: 15_000 },
              );
            }}
          >
            {locating ? t('operations.location.locating') : t('operations.location.useMyLocation')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!changed || saving}
            aria-busy={saving}
            onClick={() => save({ latitude, longitude })}
          >
            {t('operations.location.pin')}
          </button>
          {status === 'manual' ? (
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={saving}
              onClick={() => save(null)}
            >
              {t('operations.location.clearPin')}
            </button>
          ) : null}
        </div>
      ) : null}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
