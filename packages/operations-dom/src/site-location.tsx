import { useTranslation } from '@integr8/i18n';
import type * as Leaflet from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { useOperations } from './api.js';
import { buttonClass, Field, inputClass } from './ui.js';

export interface Location {
  latitude: number;
  longitude: number;
}

type GeocodeStatus = 'pending' | 'found' | 'not_found' | 'failed' | 'manual';

/**
 * Where a site is, and how a person corrects it.
 *
 * The address is geocoded by the server. When that is wrong or impossible —
 * a new estate, a gate round the back — a person drops a pin on the map, types
 * coordinates, or stands on the spot and uses their device's location. A pin
 * placed by hand is kept until the address changes.
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
  const { mapTiles } = useOperations();
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
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
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

      {mapTiles === undefined ? null : (
        <PinMap
          tiles={mapTiles}
          location={valid ? { latitude, longitude } : location}
          editable={editable}
          onPlace={place}
        />
      )}

      {editable ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('operations.location.latitude')}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
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
                className={inputClass}
                value={draft.longitude}
                onChange={(event) => setDraft({ ...draft, longitude: event.target.value })}
              />
            )}
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {editable ? (
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={
                locating || typeof navigator === 'undefined' || !('geolocation' in navigator)
              }
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
              {locating
                ? t('operations.location.locating')
                : t('operations.location.useMyLocation')}
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
          </>
        ) : null}
        {location === null ? null : (
          <a
            className={buttonClass.ghost}
            href={`https://www.openstreetmap.org/?mlat=${String(location.latitude)}&mlon=${String(location.longitude)}#map=18/${String(location.latitude)}/${String(location.longitude)}`}
            target="_blank"
            rel="noreferrer"
          >
            {t('operations.location.openMap')}
          </a>
        )}
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * A Leaflet map with one pin. Loaded only in the browser, and only when the app
 * has told us where tiles may come from. Keyboard users have the coordinate
 * fields and the device location; the map is a faster way to the same values.
 */
function PinMap({
  tiles,
  location,
  editable,
  onPlace,
}: {
  tiles: NonNullable<ReturnType<typeof useOperations>['mapTiles']>;
  location: Location | null;
  editable: boolean;
  onPlace: (location: Location) => void;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const state = useRef<{
    map?: Leaflet.Map;
    marker?: Leaflet.Marker;
    leaflet?: typeof Leaflet;
  }>({});
  const place = useRef(onPlace);
  const latest = useRef(location);
  useEffect(() => {
    place.current = onPlace;
    latest.current = location;
  }, [onPlace, location]);

  /** Puts the pin where `latest` says, once the map exists. */
  const syncPin = useRef(() => {
    const { map, leaflet: L } = state.current;
    const where = latest.current;
    if (map === undefined || L === undefined) {
      return;
    }
    if (where === null) {
      state.current.marker?.remove();
      delete state.current.marker;
      return;
    }
    const position: [number, number] = [where.latitude, where.longitude];
    if (state.current.marker === undefined) {
      state.current.marker = L.marker(position, {
        icon: L.divIcon({
          className: 'integr8-pin',
          html: '<span></span>',
          iconSize: [24, 24],
          iconAnchor: [12, 24],
        }),
        keyboard: false,
      }).addTo(map);
    } else {
      state.current.marker.setLatLng(position);
    }
    map.panTo(position);
  });

  useEffect(() => {
    let cancelled = false;
    const element = container.current;
    if (element === null) {
      return;
    }
    void import('leaflet').then((module) => {
      const L = (module as unknown as { default?: typeof Leaflet }).default ?? module;
      if (cancelled) {
        return;
      }
      ensureLeafletStyles();
      const map = L.map(element, { attributionControl: true }).setView(
        location === null ? [51.5, -0.12] : [location.latitude, location.longitude],
        location === null ? 5 : 17,
      );
      L.tileLayer(tiles.url, {
        attribution: tiles.attribution,
        maxZoom: tiles.maxZoom ?? 19,
      }).addTo(map);
      if (editable) {
        map.on('click', (event) =>
          place.current({ latitude: event.latlng.lat, longitude: event.latlng.lng }),
        );
      }
      state.current = { map, leaflet: L };
      syncPin.current();
    });
    return () => {
      cancelled = true;
      state.current.map?.remove();
      state.current = {};
    };
    // The map is created once; the pin follows `location` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles.url, editable]);

  useEffect(() => {
    syncPin.current();
  }, [location]);

  return (
    <div
      ref={container}
      role="img"
      aria-label={t('operations.location.mapLabel')}
      className="h-64 w-full overflow-hidden rounded-md border border-border-subtle"
    />
  );
}

/** The few Leaflet rules a map needs to lay out, so no app has to import a stylesheet from node_modules. */
function ensureLeafletStyles() {
  if (document.getElementById('integr8-leaflet') !== null) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'integr8-leaflet';
  style.textContent = `
.leaflet-container{position:relative;overflow:hidden;outline:0;touch-action:none;background:#ddd}
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}
.leaflet-tile,.leaflet-marker-icon{user-select:none;-webkit-user-drag:none}
.leaflet-tile{visibility:hidden}.leaflet-tile-loaded{visibility:inherit}
.leaflet-container img.leaflet-tile{max-width:none!important;max-height:none!important;width:256px;height:256px}
.leaflet-map-pane{z-index:0}.leaflet-tile-pane{z-index:200}.leaflet-marker-pane{z-index:600}
.leaflet-control-container .leaflet-top,.leaflet-control-container .leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}
.leaflet-top{top:0}.leaflet-bottom{bottom:0}.leaflet-left{left:0}.leaflet-right{right:0}
.leaflet-control{position:relative;z-index:800;pointer-events:auto;float:left;clear:both}
.leaflet-right .leaflet-control{float:right}.leaflet-top .leaflet-control{margin-top:10px}.leaflet-left .leaflet-control{margin-left:10px}
.leaflet-bottom .leaflet-control{margin-bottom:0}.leaflet-right .leaflet-control{margin-right:0}
.leaflet-bar{background:#fff;border:1px solid #aaa;border-radius:4px}
.leaflet-bar a{display:block;width:30px;height:30px;line-height:30px;text-align:center;color:#000;text-decoration:none;font:bold 18px monospace}
.leaflet-control-attribution{background:rgba(255,255,255,.8);margin:0;padding:0 5px;font-size:11px;color:#333}
.leaflet-control-attribution a{color:#0078a8}
.leaflet-zoom-animated{transform-origin:0 0}
.integr8-pin span{display:block;width:24px;height:24px;border-radius:50% 50% 50% 0;background:#d9480f;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 4px rgba(0,0,0,.4)}
`;
  document.head.append(style);
}
