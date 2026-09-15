import {
  type Answers,
  type CompiledForm,
  evaluateForm,
  type Field,
  isAnswered,
  mediaReferenceSchema,
} from '@integr8/form-engine';
import { formatBytes, say } from '@integr8/form-input';
import { formatDate, formatDateTime, formatList, useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import { imageUri, useFormMedia } from './media';
import { references } from './widgets/files';
import { ActionButton } from './widgets/kit';

/**
 * Answers, read back: the review before submitting, and a submitted form. Only
 * questions visible for these answers are listed — the same evaluation the form
 * used — so what is shown is exactly what is sent.
 */
export function AnswerList({
  form,
  answers,
  locale,
  today,
  onChangePage,
}: {
  form: CompiledForm;
  answers: Answers;
  locale: string;
  today: string | undefined;
  /** Offers "Change" per page, with the page's index among all pages. */
  onChangePage?: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { visible, values } = evaluateForm(form, answers, today === undefined ? {} : { today });
  const pages = form.definition.pages.filter((page) => visible.get(page.id) === true);

  return (
    <View style={styles.list}>
      {pages.map((page, index) => (
        <View key={page.id} style={styles.page}>
          <View style={styles.pageHeader}>
            <Text accessibilityRole="header" style={[styles.pageTitle, { color: theme.text }]}>
              {say(page.title, locale) || t('fill.nav.page', { number: index + 1 })}
            </Text>
            {onChangePage === undefined ? null : (
              <ActionButton
                tone="quiet"
                label={t('fill.actions.change')}
                onPress={() => onChangePage(page.id)}
              />
            )}
          </View>
          {page.sections
            .filter((section) => visible.get(section.id) === true)
            .map((section) => (
              <View
                key={section.id}
                style={[
                  styles.section,
                  { borderColor: theme.border, backgroundColor: theme.surface },
                ]}
              >
                {section.title === undefined ? null : (
                  <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>
                    {say(section.title, locale)}
                  </Text>
                )}
                {section.fields
                  .filter((field) => visible.get(field.id) === true)
                  .map((field) => (
                    <View key={field.id} style={styles.answer}>
                      <Text style={[styles.question, { color: theme.textMuted }]}>
                        {say(field.label, locale) || field.id}
                      </Text>
                      <AnswerValue field={field} value={values.get(field.id)} locale={locale} />
                    </View>
                  ))}
              </View>
            ))}
        </View>
      ))}
    </View>
  );
}

function AnswerValue({ field, value, locale }: { field: Field; value: unknown; locale: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const media = useFormMedia();
  const plain = (content: string, muted = false) => (
    <Text style={[styles.value, { color: muted ? theme.textMuted : theme.text }]}>{content}</Text>
  );

  if (!isAnswered(field, value)) {
    return plain(t('fill.unanswered'), true);
  }
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
    case 'time':
      return plain(String(value));
    case 'number':
    case 'decimal':
      return plain(`${String(value)}${field.unit === undefined ? '' : ` ${field.unit}`}`);
    case 'date':
      return plain(formatDate(`${String(value)}T12:00:00Z`, { locale, timeZone: 'UTC' }));
    case 'datetime':
      return plain(formatDateTime(String(value), { locale }));
    case 'dropdown':
    case 'radio': {
      const option = field.options.find((candidate) => candidate.value === value);
      return plain(option === undefined ? String(value) : say(option.label, locale));
    }
    case 'multi_select':
      return plain(
        formatList(
          (value as string[]).map((chosen) => {
            const option = field.options.find((candidate) => candidate.value === chosen);
            return option === undefined ? chosen : say(option.label, locale);
          }),
          { locale },
        ),
      );
    case 'checkbox':
      return plain(value === true ? t('fill.ticked') : t('fill.notTicked'));
    case 'yes_no':
      return plain(
        value === 'yes' ? t('fill.yes') : value === 'no' ? t('fill.no') : t('fill.notApplicable'),
      );
    case 'rating':
      return plain(t('fill.rating', { value: Number(value), scale: field.scale }));
    case 'gps': {
      const point = value as { latitude: string; longitude: string };
      return plain(t('fill.gps.value', { latitude: point.latitude, longitude: point.longitude }));
    }
    case 'signature': {
      const parsed = mediaReferenceSchema.safeParse(value);
      const uri = parsed.success
        ? imageUri(media.local.get(parsed.data.mediaId), false)
        : undefined;
      return uri === undefined ? (
        plain(t('mobile.fill.photo.elsewhere'), true)
      ) : (
        <Image source={{ uri }} style={styles.signature} resizeMode="contain" />
      );
    }
    case 'photo':
    case 'file': {
      const files = references(value);
      if (field.type === 'file') {
        return plain(
          files
            .map(
              (file, index) =>
                `${t('fill.files.file', { number: index + 1 })} · ${formatBytes(file.byteSize, locale)}`,
            )
            .join('\n'),
        );
      }
      return (
        <View style={styles.thumbnails}>
          {files.map((file, index) => {
            const uri = imageUri(media.local.get(file.mediaId));
            return uri === undefined ? (
              <View
                key={file.mediaId}
                style={[styles.thumbnail, { backgroundColor: theme.surfaceMuted }]}
              />
            ) : (
              <Image
                key={file.mediaId}
                source={{ uri }}
                style={styles.thumbnail}
                accessibilityLabel={t('fill.files.photo', { number: index + 1 })}
              />
            );
          })}
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  list: { gap: spacing[6] },
  page: { gap: spacing[3] },
  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pageTitle: { flex: 1, fontSize: fontSize.xl, fontWeight: '600', textAlign: 'auto' },
  section: { gap: spacing[3], borderWidth: 1, borderRadius: radii.lg, padding: spacing[4] },
  sectionTitle: { fontSize: fontSize.sm, fontWeight: '600', textAlign: 'auto' },
  answer: { gap: 2 },
  question: { fontSize: fontSize.sm, textAlign: 'auto' },
  value: { fontSize: fontSize.lg, textAlign: 'auto' },
  signature: { width: '100%', aspectRatio: 3, borderRadius: radii.md, backgroundColor: '#ffffff' },
  thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  thumbnail: { width: 72, height: 72, borderRadius: radii.sm },
});
