import { useTranslation } from '@integr8/i18n';
import { assetByScan } from '@integr8/offline';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { LocalGate } from '~/components/local-gate';
import { Body, Button, Heading, ScrollScreen } from '~/components/ui';
import { BarcodeScanner } from '~/forms/widgets/barcode';
import { localData } from '~/local/local-data';

/**
 * Scanning an asset tag (CRM/ERP plan, phase E3; ADR-0008). The QR code holds
 * a link; the code in it — or a manufacturer's serial on a plate — is looked
 * up in the phone's own copy, so this works with no signal. From a job, the
 * asset opens ready to be linked to it.
 */
export default function ScanScreen() {
  return (
    <LocalGate>
      <Scan />
    </LocalGate>
  );
}

function Scan() {
  const { t } = useTranslation();
  const { workOrderId } = useLocalSearchParams<{ workOrderId?: string }>();
  const [scanning, setScanning] = useState(true);
  const [missed, setMissed] = useState<string | null>(null);

  const found = (scanned: string) => {
    setScanning(false);
    const status = localData.status();
    if (status.phase !== 'open') {
      setMissed(scanned);
      return;
    }
    void status.db
      .read((sql) => assetByScan(sql, scanned))
      .then((asset) => {
        if (asset === undefined) {
          setMissed(scanned);
          return;
        }
        router.replace({
          pathname: '/assets/[id]',
          params: {
            id: asset.data.asset.id,
            ...(workOrderId === undefined ? {} : { workOrderId }),
          },
        });
      })
      .catch(() => setMissed(scanned));
  };

  return (
    <ScrollScreen>
      <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      <Heading>{t('mobile.assets.scanTitle')}</Heading>
      {missed === null ? (
        <Body muted>{t('mobile.assets.scanHint')}</Body>
      ) : (
        <>
          <Body>{t('mobile.assets.notFound')}</Body>
          <Body muted>{t('mobile.assets.notFoundHint')}</Body>
        </>
      )}
      <Button
        label={t('mobile.assets.scanAgain')}
        onPress={() => {
          setMissed(null);
          setScanning(true);
        }}
      />
      {workOrderId === undefined ? null : (
        <Button
          label={t('mobile.assets.register')}
          variant="secondary"
          onPress={() => router.replace({ pathname: '/assets/new', params: { workOrderId } })}
        />
      )}
      {scanning ? <BarcodeScanner onScanned={found} onCancel={() => setScanning(false)} /> : null}
    </ScrollScreen>
  );
}
