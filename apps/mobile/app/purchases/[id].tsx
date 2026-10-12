import { useTranslation } from '@integr8/i18n';
import { job } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Body,
  Button,
  Field,
  Heading,
  NotReadyScreen,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { type CapturedFile, choosePhotos, discardCaptured, takePhoto } from '~/forms/capture';
import { isDecimal, isPositiveDecimal } from '~/lib/decimal';
import { refusalMessage } from '~/lib/refusals';
import { recordBought } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';

/**
 * A part bought from a merchant for this job (ADR-0012), with or without
 * signal: what it was, where from, how many, the price paid for one — a
 * decimal string, never a JavaScript number — and a photo of the receipt. It
 * is recorded on the phone and sent with the job, the receipt after it.
 * Nothing enters stock; paying the engineer back stays an expense claim.
 */
export default function BoughtScreen() {
  return (
    <LocalGate>
      <Bought />
    </LocalGate>
  );
}

function Bought() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(`bought:${id}`, ['work_orders'], (sql) => job(sql, id));
  const [description, setDescription] = useState('');
  const [merchant, setMerchant] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [note, setNote] = useState('');
  const [receipts, setReceipts] = useState<CapturedFile[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  if (state.data === undefined) {
    return (
      <ScrollScreen>
        <BackButton />
        <Body>{t('mobile.job.notOnPhone')}</Body>
      </ScrollScreen>
    );
  }
  const { detail } = state.data;

  const problems = {
    description: description.trim() === '' ? t('mobile.bought.descriptionRequired') : undefined,
    quantity: isPositiveDecimal(quantity) ? undefined : t('mobile.parts.invalidQuantity'),
    unitPrice: isDecimal(unitPrice) ? undefined : t('mobile.bought.unitPriceInvalid'),
  };
  const ready = Object.values(problems).every((problem) => problem === undefined);
  const shown = (problem: string | undefined) => (tried ? problem : undefined);

  const capture = (source: 'camera' | 'library') => {
    void (source === 'camera' ? takePhoto() : choosePhotos(3)).then((captured) => {
      if (captured.outcome === 'captured') {
        setReceipts((all) => [...all, ...captured.files]);
      } else if (captured.outcome === 'denied') {
        Alert.alert(t('mobile.expenses.cameraDenied'));
      }
    });
  };

  const save = () => {
    setTried(true);
    if (!ready) {
      return;
    }
    setBusy(true);
    recordBought({
      workOrderId: detail.workOrder.id,
      description,
      merchant,
      quantity: quantity.trim(),
      unitPrice: unitPrice.trim(),
      note,
      receipts,
      receiptTitle: (index) => t('mobile.bought.receiptTitle', { number: index }),
    })
      .then(() => router.back())
      .catch((error: unknown) =>
        Alert.alert(t('mobile.bought.failed'), refusalMessage(t, error, t('mobile.work.failed'))),
      )
      .finally(() => setBusy(false));
  };

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.bought.title')}</Heading>
      <Body muted>
        {detail.workOrder.referenceLabel} · {detail.workOrder.title}
      </Body>
      <Body muted>{t('mobile.bought.intro')}</Body>

      <Field
        label={t('mobile.bought.description')}
        value={description}
        onChangeText={setDescription}
        maxLength={300}
        error={shown(problems.description)}
      />
      <Field
        label={t('mobile.bought.merchant')}
        value={merchant}
        onChangeText={setMerchant}
        maxLength={200}
      />
      <Field
        label={t('mobile.bought.quantity')}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="decimal-pad"
        error={shown(problems.quantity)}
      />
      <Field
        label={t('mobile.bought.unitPrice')}
        value={unitPrice}
        onChangeText={setUnitPrice}
        keyboardType="decimal-pad"
        error={shown(problems.unitPrice)}
      />
      <Field
        label={t('mobile.bought.note')}
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={1000}
      />

      <Section title={t('mobile.bought.receipt')}>
        <Body muted>
          {receipts.length === 0 ? t('mobile.bought.noReceipt') : t('mobile.bought.receiptHint')}
        </Body>
        {receipts.map((file, index) => (
          <Row
            key={file.localPath}
            title={t('mobile.bought.receiptTitle', { number: index + 1 })}
            lines={[t('mobile.expenses.tapToRemove')]}
            onPress={() => {
              discardCaptured(file);
              setReceipts((all) => all.filter((item) => item.localPath !== file.localPath));
            }}
          />
        ))}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
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

      <Button label={t('mobile.bought.record')} busy={busy} onPress={save} />
      <Body muted>{t('mobile.bought.sentLater')}</Body>
    </ScrollScreen>
  );
}
