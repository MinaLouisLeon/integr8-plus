import { useTranslation } from '@integr8/i18n';
import { deviceToday, expenseCategories, openJobs } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Body,
  Button,
  Field,
  Heading,
  LocalReadError,
  Row,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { type CapturedFile, choosePhotos, discardCaptured, takePhoto } from '~/forms/capture';
import { claimExpense } from '~/local/expense-actions';
import { useLocalQuery } from '~/local/react';
import { refusalMessage } from '~/lib/refusals';

const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/u;

/**
 * Claiming an expense back from the phone (ADR-0010), with or without
 * signal: what it was for — one of the categories the office last said are
 * in use — the day it was spent, the amount, a description, the job if it
 * was for one, and a photo of each receipt. It is sent, receipts after it,
 * when the phone next can.
 */
export default function NewExpenseScreen() {
  return (
    <LocalGate>
      <NewExpense />
    </LocalGate>
  );
}

function NewExpense() {
  const { t } = useTranslation();
  const theme = useTheme();
  const state = useLocalQuery('expense-form', ['meta', 'work_orders', 'sites'], async (sql) => ({
    categories: await expenseCategories(sql),
    jobs: await openJobs(sql),
  }));
  const [today] = useState(() => deviceToday(new Date()));
  const [yesterday] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return deviceToday(date);
  });
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [spentOn, setSpentOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [workOrderId, setWorkOrderId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<CapturedFile[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.status === 'error') {
    return (
      <ScrollScreen>
        <BackButton />
        <LocalReadError />
      </ScrollScreen>
    );
  }
  if (state.status !== 'ready') {
    return (
      <ScrollScreen>
        <BackButton />
      </ScrollScreen>
    );
  }

  const problems = {
    category: categoryId === null ? t('expenses.form.categoryRequired') : undefined,
    spentOn: !/^\d{4}-\d{2}-\d{2}$/u.test(spentOn)
      ? t('mobile.expenses.dateFormat')
      : spentOn > today
        ? t('apiErrors.spent_in_future')
        : undefined,
    amount:
      AMOUNT.test(amount.trim()) && /[1-9]/u.test(amount)
        ? undefined
        : t('expenses.form.amountInvalid'),
    description: description.trim() === '' ? t('expenses.form.descriptionRequired') : undefined,
  };
  const ready = Object.values(problems).every((problem) => problem === undefined);
  const shown = (problem: string | undefined) => (tried ? problem : undefined);

  const capture = (source: 'camera' | 'library') => {
    void (source === 'camera' ? takePhoto() : choosePhotos(5)).then((captured) => {
      if (captured.outcome === 'captured') {
        setReceipts((all) => [...all, ...captured.files]);
      } else if (captured.outcome === 'denied') {
        Alert.alert(t('mobile.expenses.cameraDenied'));
      }
    });
  };

  const save = () => {
    setTried(true);
    if (!ready || categoryId === null) {
      return;
    }
    setBusy(true);
    claimExpense({
      categoryId,
      spentOn,
      amount: amount.trim(),
      description,
      ...(workOrderId === null ? {} : { workOrderId }),
      receipts,
      receiptTitle: (index) => t('mobile.expenses.receiptTitle', { number: index }),
    })
      .then(() => router.replace('/expenses'))
      .catch((error: unknown) =>
        Alert.alert(t('mobile.expenses.failed'), refusalMessage(t, error, '')),
      )
      .finally(() => setBusy(false));
  };

  const chip = (key: string, label: string, chosen: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          borderColor: chosen ? theme.accent : theme.border,
          backgroundColor: chosen ? theme.accent : theme.surface,
        },
      ]}
    >
      <Text style={{ color: chosen ? theme.onAccent : theme.text, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );

  if (state.data.categories.length === 0) {
    return (
      <ScrollScreen>
        <BackButton />
        <Heading>{t('expenses.form.title')}</Heading>
        <Body muted>{t('mobile.expenses.noCategories')}</Body>
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('expenses.form.title')}</Heading>
      <Body muted>{t('mobile.expenses.formIntro')}</Body>

      <Section title={t('expenses.field.category')}>
        <View style={styles.choices} accessibilityRole="radiogroup">
          {state.data.categories.map((category) =>
            chip(category.id, category.name, categoryId === category.id, () =>
              setCategoryId(category.id),
            ),
          )}
        </View>
        {shown(problems.category) === undefined ? null : (
          <Text accessibilityRole="alert" style={{ color: theme.danger }}>
            {problems.category}
          </Text>
        )}
      </Section>

      <Section title={t('expenses.field.spentOn')}>
        <View style={styles.choices}>
          {chip('today', t('mobile.expenses.today'), spentOn === today, () => setSpentOn(today))}
          {chip('yesterday', t('mobile.expenses.yesterday'), spentOn === yesterday, () =>
            setSpentOn(yesterday),
          )}
        </View>
        <Field
          label={t('mobile.expenses.otherDate')}
          value={spentOn}
          onChangeText={setSpentOn}
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          error={shown(problems.spentOn)}
        />
      </Section>

      <Field
        label={t('expenses.field.amount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        error={shown(problems.amount)}
      />
      <Field
        label={t('expenses.field.description')}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={1000}
        error={shown(problems.description)}
      />

      {state.data.jobs.length === 0 ? null : (
        <Section title={t('mobile.expenses.forJob')}>
          <View style={styles.choices}>
            {chip('none', t('expenses.form.noWorkOrder'), workOrderId === null, () =>
              setWorkOrderId(null),
            )}
            {state.data.jobs.map((job) =>
              chip(job.id, job.referenceLabel, workOrderId === job.id, () =>
                setWorkOrderId(job.id),
              ),
            )}
          </View>
        </Section>
      )}

      <Section title={t('expenses.receipts.title')}>
        <Body muted>{t('mobile.expenses.receiptsHint')}</Body>
        {receipts.map((file, index) => (
          <Row
            key={file.localPath}
            title={t('mobile.expenses.receiptTitle', { number: index + 1 })}
            lines={[t('mobile.expenses.tapToRemove')]}
            onPress={() => {
              discardCaptured(file);
              setReceipts((all) => all.filter((item) => item.localPath !== file.localPath));
            }}
          />
        ))}
        <View style={styles.choices}>
          <Button
            label={t('mobile.expenses.takePhoto')}
            variant="secondary"
            onPress={() => capture('camera')}
          />
          <Button
            label={t('mobile.expenses.choosePhoto')}
            variant="secondary"
            onPress={() => capture('library')}
          />
        </View>
      </Section>

      <Button
        label={busy ? t('expenses.form.submitting') : t('expenses.form.submit')}
        busy={busy}
        onPress={save}
      />
      <Body muted>{t('mobile.expenses.sentLater')}</Body>
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  choice: {
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
