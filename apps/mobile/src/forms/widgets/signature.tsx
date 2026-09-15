import { mediaReferenceSchema } from '@integr8/form-engine';
import {
  SIGNATURE_HEIGHT,
  SIGNATURE_INK,
  SIGNATURE_PAPER,
  SIGNATURE_STROKE,
  SIGNATURE_WIDTH,
  type SignaturePoint,
  strokesToPath,
  toPadPoint,
  worthKeeping,
} from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { radii, spacing } from '@integr8/tokens';
import { useEffect, useRef, useState } from 'react';
import { Image, type LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Path, Rect, Text as SvgText } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { useTheme } from '~/components/ui';
import { discardCaptured, keepSignature } from '../capture';
import { imageUri, useFormMedia } from '../media';
import { ActionButton, Muted, Problem, styles as kit, TextBox, type WidgetProps } from './kit';

/**
 * A signature, drawn with a finger or a stylus.
 *
 * The pad takes the touch the moment it lands and does not give it back to the
 * scrolling form, so signing never scrolls the page. Points closer than a pixel
 * and a half are dropped, which keeps a long signature smooth on a cheap phone.
 * The pad is drawn in the same 480 × 160 space as the desktop's and saved as a
 * PNG at twice that size, so a signature from either reads the same on a
 * certificate.
 *
 * A drawing cannot be made by everyone, so a typed name is always offered too,
 * drawn into the same image.
 */

type Stroke = SignaturePoint[];

export function SignatureWidget(props: WidgetProps<'signature'>) {
  const { value, label, disabled, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const media = useFormMedia();
  const parsed = mediaReferenceSchema.safeParse(value);

  if (parsed.success) {
    const uri = imageUri(media.local.get(parsed.data.mediaId), false);
    return (
      <View style={kit.stack}>
        {uri === undefined ? (
          <Muted>{t('mobile.fill.photo.elsewhere')}</Muted>
        ) : (
          <Image
            source={{ uri }}
            accessibilityLabel={t('fill.signature.image', { question: label })}
            style={styles.saved}
            resizeMode="contain"
          />
        )}
        {disabled ? null : (
          <ActionButton
            label={t('fill.signature.replace')}
            onPress={() => {
              onClear();
              onBlur();
              void media.remove(parsed.data);
            }}
          />
        )}
      </View>
    );
  }

  return (
    <SignaturePad
      label={label}
      disabled={disabled}
      onSaved={async (uri) => {
        const file = await keepSignature(uri);
        try {
          const [reference] = await media.add([file]);
          onAnswer(reference);
          onBlur();
        } catch (error) {
          discardCaptured(file);
          throw error;
        }
      }}
    />
  );
}

function SignaturePad({
  label,
  disabled,
  onSaved,
}: {
  label: string;
  disabled: boolean;
  onSaved: (uri: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const surface = useRef<View>(null);
  const [path, setPath] = useState('');
  // The drawing in progress lives outside React state: a finger reports points
  // far faster than the pad should re-render, and only the path is drawn.
  const [ink] = useState(() => new Ink(setPath));
  useEffect(() => {
    ink.setDisabled(disabled);
  }, [ink, disabled]);
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const hasInk = mode === 'draw' ? path !== '' : typed.trim() !== '';

  const save = async () => {
    if (!hasInk || surface.current === null) {
      setProblem(t('fill.signature.empty'));
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      const uri = await captureRef(surface, {
        format: 'png',
        result: 'tmpfile',
        width: SIGNATURE_WIDTH * 2,
        height: SIGNATURE_HEIGHT * 2,
      });
      await onSaved(uri);
    } catch {
      setProblem(t('fill.files.failed', { name: t('fill.signature.pad') }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={kit.stack}>
      {mode === 'type' ? (
        <TextBox
          accessibilityLabel={t('fill.signature.typedName')}
          placeholder={t('fill.signature.typedName')}
          value={typed}
          editable={!disabled}
          invalid={false}
          autoComplete="name"
          onChangeText={setTyped}
        />
      ) : (
        <Muted>{t('mobile.fill.signature.hint')}</Muted>
      )}
      <View
        ref={surface}
        collapsable={false}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${label}: ${t('fill.signature.pad')}`}
        onLayout={(event: LayoutChangeEvent) => ink.resize(event.nativeEvent.layout)}
        style={[styles.pad, { borderColor: theme.borderStrong }]}
        {...(mode === 'draw' ? ink.responder.panHandlers : {})}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${String(SIGNATURE_WIDTH)} ${String(SIGNATURE_HEIGHT)}`}
        >
          <Rect
            x={0}
            y={0}
            width={SIGNATURE_WIDTH}
            height={SIGNATURE_HEIGHT}
            fill={SIGNATURE_PAPER}
          />
          {mode === 'draw' ? (
            <Path
              d={path}
              stroke={SIGNATURE_INK}
              strokeWidth={SIGNATURE_STROKE}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ) : (
            <SvgText
              x={16}
              y={SIGNATURE_HEIGHT / 2 + 12}
              fill={SIGNATURE_INK}
              fontSize={36}
              fontStyle="italic"
            >
              {typed}
            </SvgText>
          )}
        </Svg>
      </View>

      <View style={kit.row}>
        {mode === 'draw' ? (
          <>
            <ActionButton
              tone="quiet"
              label={t('fill.signature.undo')}
              disabled={disabled || path === ''}
              onPress={() => ink.undo()}
            />
            <ActionButton
              tone="quiet"
              label={t('fill.signature.clear')}
              disabled={disabled || path === ''}
              onPress={() => ink.clear()}
            />
          </>
        ) : null}
        <ActionButton
          tone="quiet"
          label={
            mode === 'draw' ? t('fill.signature.typeInstead') : t('fill.signature.drawInstead')
          }
          disabled={disabled}
          onPress={() => setMode(mode === 'draw' ? 'type' : 'draw')}
        />
        <ActionButton
          tone="primary"
          label={saving ? t('fill.signature.saving') : t('mobile.fill.signature.use')}
          busy={saving}
          disabled={disabled}
          onPress={() => void save()}
        />
      </View>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </View>
  );
}

/** Strokes on the pad, and the touch handling that adds to them. */
class Ink {
  #disabled = false;
  #strokes: Stroke[] = [];
  #size = { width: 0, height: 0 };
  readonly #draw: (path: string) => void;
  readonly responder;

  constructor(draw: (path: string) => void) {
    this.#draw = draw;
    this.responder = PanResponder.create({
      onStartShouldSetPanResponder: () => !this.#disabled,
      onStartShouldSetPanResponderCapture: () => !this.#disabled,
      onMoveShouldSetPanResponderCapture: () => !this.#disabled,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        this.#strokes.push([toPadPoint(locationX, locationY, this.#size)]);
        this.#redraw();
      },
      onPanResponderMove: (event) => {
        const stroke = this.#strokes.at(-1);
        if (stroke === undefined) {
          return;
        }
        const { locationX, locationY } = event.nativeEvent;
        const point = toPadPoint(locationX, locationY, this.#size);
        if (worthKeeping(stroke.at(-1), point)) {
          stroke.push(point);
          this.#redraw();
        }
      },
    });
  }

  setDisabled(disabled: boolean): void {
    this.#disabled = disabled;
  }

  resize(size: { width: number; height: number }): void {
    this.#size = { width: size.width, height: size.height };
  }

  undo(): void {
    this.#strokes.pop();
    this.#redraw();
  }

  clear(): void {
    this.#strokes = [];
    this.#redraw();
  }

  #redraw(): void {
    this.#draw(strokesToPath(this.#strokes));
  }
}

const styles = StyleSheet.create({
  pad: {
    width: '100%',
    aspectRatio: SIGNATURE_WIDTH / SIGNATURE_HEIGHT,
    borderWidth: 1.5,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: SIGNATURE_PAPER,
  },
  saved: {
    width: '100%',
    aspectRatio: SIGNATURE_WIDTH / SIGNATURE_HEIGHT,
    borderRadius: radii.md,
    backgroundColor: SIGNATURE_PAPER,
    marginBottom: spacing[1],
  },
});
