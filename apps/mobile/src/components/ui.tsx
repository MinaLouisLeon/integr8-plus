import { useTranslation } from '@integr8/i18n';
import { useBrand } from '~/components/brand';
import { colours, fontSize, radii, spacing, type SemanticColours } from '@integr8/tokens';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type TextInputProps,
} from 'react-native';

/**
 * The mobile primitives.
 *
 * Written separately from the two DOM apps, because React Native has no CSS and
 * no DOM — P01's rule, and the reason `@integr8/tokens` is plain TypeScript.
 * These read exactly the same colour and spacing values the web app compiles
 * into custom properties, so a change to the palette reaches all three.
 *
 * **Right-to-left** here is `start`/`end`, not `left`/`right`. React Native
 * mirrors `paddingStart` and `textAlign: 'auto'` when the app is in RTL and
 * leaves `paddingLeft` alone — which is the same trap as CSS, with the same
 * fix, checked by the same lint rule.
 */

export function useTheme(): SemanticColours {
  // Follows the operating system. An in-app override lands with the settings
  // screen; until then, matching the phone is the behaviour people expect.
  const base = useColorScheme() === 'dark' ? colours.dark : colours.light;
  // The company's own accent, when it has one: see `brand.tsx`.
  const { accent } = useBrand();
  return accent === null ? base : { ...base, ...accent, focus: accent.accent };
}

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.screenInner}>{children}</View>
    </View>
  );
}

/**
 * A screen that scrolls: every screen that lists work. The content is on the
 * phone, so there is no pull-to-refresh spinner standing in for it.
 */
export function ScrollScreen({ children }: { children: ReactNode }) {
  const theme = useTheme();

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.scrollInner}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.textMuted }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A tappable card in a list: a job, a customer, a site. */
export function Row({
  title,
  lines = [],
  tag,
  onPress,
}: {
  title: string;
  lines?: readonly string[];
  tag?: { label: string; tone: 'danger' | 'muted' } | undefined;
  onPress?: (() => void) | undefined;
}) {
  const theme = useTheme();

  const body = (
    <>
      <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
      {lines
        .filter((line) => line !== '')
        .map((line, index) => (
          <Text key={index} style={[styles.body, { color: theme.textMuted }]}>
            {line}
          </Text>
        ))}
      {tag === undefined ? null : <Badge label={tag.label} tone={tag.tone} />}
    </>
  );

  const style = [styles.row, { backgroundColor: theme.surface, borderColor: theme.border }];
  return onPress === undefined ? (
    <View style={style}>{body}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...style, { opacity: pressed ? 0.85 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

export function Badge({ label, tone }: { label: string; tone: 'danger' | 'muted' | 'accent' }) {
  const theme = useTheme();
  const colours =
    tone === 'danger'
      ? { backgroundColor: theme.dangerSubtle, color: theme.danger }
      : tone === 'accent'
        ? { backgroundColor: theme.accentSubtle, color: theme.accent }
        : { backgroundColor: theme.surfaceMuted, color: theme.textMuted };

  return (
    <View style={[styles.badge, { backgroundColor: colours.backgroundColor }]}>
      <Text style={[styles.badgeLabel, { color: colours.color }]}>{label}</Text>
    </View>
  );
}

/** A label above a value, for details. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();

  return (
    <View style={styles.detail}>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
      {typeof children === 'string' ? (
        <Text style={[styles.body, { color: theme.text }]}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.heading, { color: theme.text }]}>{children}</Text>;
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const theme = useTheme();
  return (
    <Text style={[styles.body, { color: muted ? theme.textMuted : theme.text }]}>{children}</Text>
  );
}

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  busy?: boolean;
  disabled?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
}: ButtonProps) {
  const theme = useTheme();
  const isPrimary = variant === 'primary';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isPrimary ? theme.accent : theme.surface,
          borderColor: isPrimary ? theme.accent : theme.border,
          opacity: disabled || busy ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={isPrimary ? theme.onAccent : theme.text} /> : null}
      <Text style={[styles.buttonLabel, { color: isPrimary ? theme.onAccent : theme.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string | undefined;
}

export function Field({ label, error, ...rest }: FieldProps) {
  const theme = useTheme();

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput
        {...rest}
        accessibilityLabel={label}
        placeholderTextColor={theme.textMuted}
        style={[
          styles.input,
          {
            backgroundColor: theme.surface,
            borderColor: error === undefined ? theme.border : theme.danger,
            color: theme.text,
          },
        ]}
      />
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

export function LoadingState() {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View style={styles.centred}>
      <ActivityIndicator color={theme.accent} accessibilityLabel={t('states.loadingLabel')} />
      <Text style={[styles.body, { color: theme.textMuted }]}>{t('common.loading')}</Text>
    </View>
  );
}

export function EmptyState({ title, body }: { title?: string; body?: string }) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.heading, { color: theme.text }]}>{title ?? t('states.emptyTitle')}</Text>
      <Text style={[styles.body, { color: theme.textMuted }]}>{body ?? t('states.emptyBody')}</Text>
    </View>
  );
}

export function ErrorState({
  requestId,
  message,
  onRetry,
}: {
  requestId?: string | undefined;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View
      accessibilityRole="alert"
      style={[styles.card, { backgroundColor: theme.dangerSubtle, borderColor: theme.danger }]}
    >
      <Text style={[styles.heading, { color: theme.text }]}>{t('errors.title')}</Text>
      <Text style={[styles.body, { color: theme.text }]}>
        {message ?? t('errors.body', { requestId: requestId ?? '—' })}
      </Text>
      {onRetry === undefined ? null : (
        <Button label={t('common.retry')} variant="secondary" onPress={onRetry} />
      )}
    </View>
  );
}

/**
 * Logical, not physical — with one difference from CSS worth knowing.
 *
 * For spacing, React Native uses `paddingStart` / `marginEnd`, which mirror
 * automatically in a right-to-left layout while `paddingLeft` does not.
 *
 * For text, it does **not** accept `start`. The direction-following value is
 * `textAlign: 'auto'`; `left` and `right` are physical and stay put. Writing
 * `'left'` here is the React Native equivalent of writing `text-left` in the
 * web apps, and the lint rule rejects both.
 */
const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollInner: {
    gap: spacing[4],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[6],
  },
  section: { gap: spacing[2] },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    textAlign: 'auto',
  },
  row: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  rowTitle: { fontSize: fontSize.base, fontWeight: '600', textAlign: 'auto' },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radii.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  badgeLabel: { fontSize: fontSize.xs, fontWeight: '600' },
  detail: { gap: 2 },
  screenInner: {
    flex: 1,
    gap: spacing[4],
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
  },
  heading: { fontSize: fontSize.xl, fontWeight: '600', textAlign: 'auto' },
  body: { fontSize: fontSize.sm, textAlign: 'auto' },
  label: { fontSize: fontSize.sm, fontWeight: '500', textAlign: 'auto' },
  field: { gap: spacing[1] },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: fontSize.sm,
    textAlign: 'auto',
  },
  error: { fontSize: fontSize.xs, textAlign: 'auto' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  buttonLabel: { fontSize: fontSize.sm, fontWeight: '500' },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3] },
  card: {
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[6],
  },
});
