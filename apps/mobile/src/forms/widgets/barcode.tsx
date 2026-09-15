import { useTranslation } from '@integr8/i18n';
import { fontSize, spacing } from '@integr8/tokens';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from './kit';

/**
 * The camera, reading a barcode or QR code straight into a question. Every
 * common symbology is accepted: an appliance plate is as likely to carry a
 * Code 128 serial as a QR link. The first code read is the answer; the person
 * sees it in the field and can correct it.
 */
export function BarcodeScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (data: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={styles.screen}>
        {permission?.granted === true ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: [
                'qr',
                'code128',
                'code39',
                'code93',
                'ean13',
                'ean8',
                'upc_a',
                'upc_e',
                'itf14',
                'datamatrix',
                'pdf417',
                'aztec',
                'codabar',
              ],
            }}
            onBarcodeScanned={(result) => {
              if (done.current || result.data === '') {
                return;
              }
              done.current = true;
              onScanned(result.data);
            }}
          />
        ) : (
          <View style={styles.message}>
            {permission === null || permission.granted ? null : (
              <Text style={styles.text}>{t('mobile.fill.barcode.permission')}</Text>
            )}
          </View>
        )}
        <View style={styles.footer}>
          <Text accessibilityRole="header" style={styles.text}>
            {t('mobile.fill.barcode.title')}
          </Text>
          <ActionButton label={t('mobile.fill.barcode.cancel')} onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000' },
  camera: { flex: 1 },
  message: { flex: 1, justifyContent: 'center', padding: spacing[6] },
  footer: { gap: spacing[3], padding: spacing[4], paddingBottom: spacing[8] },
  text: { color: '#ffffff', fontSize: fontSize.lg, textAlign: 'auto' },
});
