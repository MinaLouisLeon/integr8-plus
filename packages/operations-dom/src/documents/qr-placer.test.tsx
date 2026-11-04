import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fakeApi, renderScreen } from '../testing/render.js';
import { DEFAULT_QR_PLACEMENT, fitPlacement, type QrPlacement, QrPlacer } from './qr-placer.js';

function Harness({ onChange }: { onChange: (next: QrPlacement) => void }) {
  const [value, setValue] = useState(DEFAULT_QR_PLACEMENT);
  return (
    <QrPlacer
      bytes={null}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('placing an uploaded PDF’s QR code (0075)', () => {
  it('keeps the code inside the page', () => {
    expect(fitPlacement({ page: 'first', x: 0.95, y: 0.99, size: 0.2 }, 210 / 297)).toEqual({
      page: 'first',
      x: 0.8,
      y: 1 - 0.2 * (210 / 297),
      size: 0.2,
    });
    expect(fitPlacement({ page: 'all', x: -1, y: -1, size: 0.9 }, 1).size).toBe(0.5);
  });

  it('moves the square with the arrow keys and changes the page', async () => {
    const user = userEvent.setup();
    const seen: QrPlacement[] = [];
    const { client } = fakeApi({});
    renderScreen(<Harness onChange={(next) => seen.push(next)} />, client);
    const square = screen.getByRole('button', { name: /QR code, 82% across/u });
    square.focus();
    await user.keyboard('{ArrowUp}');
    expect(seen.at(-1)?.y).toBeCloseTo(DEFAULT_QR_PLACEMENT.y - 0.01);
    await user.selectOptions(screen.getByLabelText('On'), 'last');
    expect(seen.at(-1)?.page).toBe('last');
  });
});
