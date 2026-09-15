import { geoPointSchema } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useState } from 'react';
import { editGeoPoint, geoPointFrom } from '@integr8/form-input';
import { buttonClass, inputClass, type WidgetProps } from './types.js';

/**
 * A location: from the device when it has one, typed when it does not.
 *
 * A desktop rarely has GPS and a basement rarely has a fix, so entering the
 * coordinates is always available — the question is where the work was, not
 * whether the browser could tell. Coordinates are stored as decimal text, as
 * the engine requires, never as floating-point numbers.
 */

export function GpsWidget(props: WidgetProps<'gps'>) {
  const { value, id, describedBy, disabled, invalid, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const parsed = geoPointSchema.safeParse(value);
  const point = parsed.success ? parsed.data : undefined;
  const [status, setStatus] = useState<'idle' | 'locating' | 'denied' | 'unavailable'>('idle');
  const [manual, setManual] = useState(false);

  const locate = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('unavailable');
      setManual(true);
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStatus('idle');
        onAnswer(geoPointFrom(position.coords));
        onBlur();
      },
      (error) => {
        setStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
        setManual(true);
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  };

  const update = (part: 'latitude' | 'longitude' | 'accuracyMeters', text: string) => {
    const next = editGeoPoint(point, part, text);
    if (next === undefined) {
      onClear();
    } else {
      onAnswer(next);
    }
  };

  return (
    <div className="flex flex-col gap-3" id={id} tabIndex={-1} aria-describedby={describedBy}>
      {point === undefined || manual ? null : (
        <p className="text-sm text-content">
          {t('fill.gps.value', { latitude: point.latitude, longitude: point.longitude })}
          {point.accuracyMeters === undefined ? null : (
            <span className="text-content-muted">{` ${t('fill.gps.within', { meters: point.accuracyMeters })}`}</span>
          )}
        </p>
      )}

      {disabled ? null : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={status === 'locating'}
            aria-busy={status === 'locating'}
            onClick={locate}
          >
            {status === 'locating' ? t('fill.gps.locating') : t('fill.gps.locate')}
          </button>
          {manual ? null : (
            <button type="button" className={buttonClass.ghost} onClick={() => setManual(true)}>
              {t('fill.gps.manual')}
            </button>
          )}
          {point === undefined ? null : (
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => {
                onClear();
                onBlur();
              }}
            >
              {t('fill.gps.clear')}
            </button>
          )}
        </div>
      )}

      {status === 'denied' || status === 'unavailable' ? (
        <p role="status" className="text-xs text-content-muted">
          {status === 'denied' ? t('fill.gps.denied') : t('fill.gps.unavailable')}
        </p>
      ) : null}

      {manual ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {(['latitude', 'longitude', 'accuracyMeters'] as const).map((part) => (
            <div key={part} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${part}`} className="text-xs text-content-muted">
                {part === 'accuracyMeters' ? t('fill.gps.accuracy') : t(`fill.gps.${part}`)}
              </label>
              <input
                id={`${id}-${part}`}
                type="text"
                inputMode="decimal"
                disabled={disabled}
                aria-invalid={invalid}
                value={point?.[part] ?? ''}
                onChange={(event) => update(part, event.target.value)}
                onBlur={onBlur}
                className={inputClass}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
