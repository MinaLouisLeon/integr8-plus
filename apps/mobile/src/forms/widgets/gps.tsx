import { geoPointSchema } from '@integr8/form-engine';
import { editGeoPoint, type GeoPart } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { useState } from 'react';
import { View } from 'react-native';
import { locate } from '../capture';
import { ActionButton, Muted, Problem, styles as kit, TextBox, type WidgetProps } from './kit';

/**
 * A location question: from the phone's GPS, which needs no signal, or typed
 * when there is no fix — the question is where the work was, not whether the
 * phone could tell. Stored as decimal text, the way the desktop stores it.
 */
export function GpsWidget(props: WidgetProps<'gps'>) {
  const { value, label, invalid, disabled, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const parsed = geoPointSchema.safeParse(value);
  const point = parsed.success ? parsed.data : undefined;
  const [status, setStatus] = useState<'idle' | 'locating' | 'denied' | 'unavailable'>('idle');
  const [manual, setManual] = useState(false);

  const find = async () => {
    setStatus('locating');
    const fix = await locate();
    if (fix.status === 'captured') {
      setStatus('idle');
      onAnswer(fix.point);
      onBlur();
    } else {
      setStatus(fix.status);
      setManual(true);
    }
  };

  const update = (part: GeoPart, typed: string) => {
    const next = editGeoPoint(point, part, typed);
    if (next === undefined) {
      onClear();
    } else {
      onAnswer(next);
    }
  };

  return (
    <View style={kit.stack}>
      {point === undefined || manual ? null : (
        <Muted>
          {t('fill.gps.value', { latitude: point.latitude, longitude: point.longitude })}
          {point.accuracyMeters === undefined
            ? ''
            : ` ${t('fill.gps.within', { meters: point.accuracyMeters })}`}
        </Muted>
      )}
      {disabled ? null : (
        <View style={kit.row}>
          <ActionButton
            tone="primary"
            label={status === 'locating' ? t('fill.gps.locating') : t('fill.gps.locate')}
            busy={status === 'locating'}
            onPress={() => void find()}
          />
          {manual ? null : (
            <ActionButton
              tone="quiet"
              label={t('fill.gps.manual')}
              onPress={() => setManual(true)}
            />
          )}
          {point === undefined ? null : (
            <ActionButton
              tone="quiet"
              label={t('fill.gps.clear')}
              onPress={() => {
                onClear();
                onBlur();
              }}
            />
          )}
        </View>
      )}
      {status === 'denied' ? <Problem>{t('fill.gps.denied')}</Problem> : null}
      {status === 'unavailable' ? <Problem>{t('fill.gps.unavailable')}</Problem> : null}
      {manual
        ? (['latitude', 'longitude', 'accuracyMeters'] as const).map((part) => (
            <View key={part} style={kit.stack}>
              <Muted>
                {part === 'accuracyMeters' ? t('fill.gps.accuracy') : t(`fill.gps.${part}`)}
              </Muted>
              <TextBox
                accessibilityLabel={`${label}: ${part === 'accuracyMeters' ? t('fill.gps.accuracy') : t(`fill.gps.${part}`)}`}
                keyboardType="numbers-and-punctuation"
                value={point?.[part] ?? ''}
                editable={!disabled}
                invalid={invalid}
                onChangeText={(typed) => update(part, typed)}
                onBlur={onBlur}
              />
            </View>
          ))
        : null}
    </View>
  );
}
