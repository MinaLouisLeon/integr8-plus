import { type MediaReference, mediaReferenceSchema } from '@integr8/form-engine';
import { checkChosenFiles, type FileProblem, formatBytes } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import {
  type Captured,
  type CapturedFile,
  chooseFiles,
  choosePhotos,
  discardCaptured,
  takePhoto,
} from '../capture';
import { imageUri, useFormMedia } from '../media';
import { ActionButton, Muted, Problem, styles as kit, type WidgetProps } from './kit';

/**
 * Photos and files. A photo is taken with the camera or chosen from the phone,
 * made smaller at once, checked against the question's limits, and queued for
 * upload; the answer holds the id it will be known by. Each shows whether it has
 * reached the office yet.
 */

export function references(value: unknown): MediaReference[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = mediaReferenceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

export function FilesWidget(props: WidgetProps<'photo' | 'file'>) {
  const { field, value, label, disabled, locale, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const media = useFormMedia();
  const chosen = references(value);
  const photos = field.type === 'photo';
  const room =
    field.maxFiles === undefined ? Number.POSITIVE_INFINITY : field.maxFiles - chosen.length;
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const describe = (problem: FileProblem) =>
    problem.code === 'too_many'
      ? t('fill.files.tooMany', { maximum: problem.maximum })
      : problem.code === 'wrong_type'
        ? t('fill.files.wrongType', { name: problem.name })
        : t('fill.files.tooLarge', {
            name: problem.name,
            maximum: formatBytes(problem.maximum, locale),
          });

  const add = async (capture: () => Promise<Captured<CapturedFile[]>>) => {
    setBusy(true);
    setProblems([]);
    try {
      const result = await capture();
      if (result.outcome !== 'captured') {
        if (result.outcome === 'denied') {
          setProblems([t('mobile.fill.photo.permission')]);
        }
        return;
      }
      const checked = checkChosenFiles(field, chosen.length, result.files);
      for (const file of result.files) {
        if (!checked.accepted.includes(file)) {
          discardCaptured(file);
        }
      }
      setProblems(checked.problems.map(describe));
      if (checked.accepted.length > 0) {
        onAnswer([...chosen, ...(await media.add(checked.accepted))]);
      }
    } catch (error) {
      setProblems([
        t('mobile.fill.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      ]);
    } finally {
      setBusy(false);
      onBlur();
    }
  };

  return (
    <View style={kit.stack}>
      {chosen.length === 0 ? null : (
        <View style={styles.grid}>
          {chosen.map((reference, index) => {
            const local = media.local.get(reference.mediaId);
            const name = photos
              ? t('fill.files.photo', { number: index + 1 })
              : t('fill.files.file', { number: index + 1 });
            const uri = photos ? imageUri(local) : undefined;
            const status =
              local === undefined
                ? t('mobile.fill.photo.elsewhere')
                : local.state === 'confirmed'
                  ? t('mobile.fill.photo.uploaded')
                  : t('mobile.fill.photo.waiting');
            return (
              <View
                key={`${reference.mediaId}-${String(index)}`}
                style={[styles.item, { borderColor: theme.border, backgroundColor: theme.surface }]}
              >
                {photos ? (
                  uri === undefined ? (
                    <View style={[styles.thumbnail, { backgroundColor: theme.surfaceMuted }]} />
                  ) : (
                    <Image
                      source={{ uri }}
                      style={styles.thumbnail}
                      accessibilityLabel={`${label}: ${name}`}
                    />
                  )
                ) : (
                  <Text style={[styles.fileName, { color: theme.text }]}>
                    {`${name} · ${formatBytes(reference.byteSize, locale)}`}
                  </Text>
                )}
                <Muted>{status}</Muted>
                {disabled ? null : (
                  <ActionButton
                    tone="quiet"
                    label={t('fill.files.remove', { name })}
                    onPress={() => {
                      const rest = chosen.filter((_, at) => at !== index);
                      onAnswer(rest);
                      onBlur();
                      void media.remove(reference);
                    }}
                  />
                )}
              </View>
            );
          })}
        </View>
      )}

      {disabled || room <= 0 ? null : photos ? (
        <View style={kit.row}>
          <ActionButton
            tone="primary"
            label={busy ? t('mobile.fill.photo.preparing') : t('mobile.fill.photo.take')}
            busy={busy}
            onPress={() => void add(takePhoto)}
          />
          <ActionButton
            label={t('mobile.fill.photo.library')}
            disabled={busy}
            onPress={() => void add(() => choosePhotos(room))}
          />
        </View>
      ) : (
        <ActionButton
          label={t('mobile.fill.file.choose')}
          busy={busy}
          onPress={() =>
            void add(() => chooseFiles(field.type === 'file' ? field.acceptedTypes : undefined))
          }
        />
      )}

      {problems.map((problem) => (
        <Problem key={problem}>{problem}</Problem>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  item: {
    width: 148,
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing[2],
  },
  thumbnail: { width: 130, height: 130, borderRadius: radii.sm },
  fileName: { fontSize: fontSize.sm, textAlign: 'auto' },
});
