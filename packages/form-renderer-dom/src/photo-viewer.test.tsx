import type { Field } from '@integr8/form-engine';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AnswerView } from './answer-view.js';
import type { MediaAdapter } from './media.js';
import { compile, renderWithI18n } from './testing/render.js';

/** A submitted form's photos open large, one after another, zoomed and saved (0075). */

const photos: Field = { id: 'photos', type: 'photo', label: { en: 'Meter photos' } };
const form = compile({
  schemaVersion: 1,
  title: { en: 'Meter read' },
  pages: [{ id: 'page_1', title: { en: 'Visit' }, sections: [{ id: 's', fields: [photos] }] }],
});

const media: MediaAdapter = {
  upload: () => Promise.reject(new Error('not used')),
  url: (reference) => Promise.resolve(`https://files.example/${reference.mediaId}.jpg`),
};

const reference = (id: string) => ({
  mediaId: `00000000-0000-4000-8000-0000000000${id}`,
  contentType: 'image/jpeg',
  byteSize: 1000,
});

describe('a submitted photo', () => {
  it('opens large, moves to the next one, zooms and links to the original', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <AnswerView
        form={form}
        locale="en"
        media={media}
        answers={{ photos: [reference('01'), reference('02')] }}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Meter photos: open photo 1 large' }),
    );
    const viewer = await screen.findByRole('dialog', { name: /Photo 1 of 2/u });
    expect(
      await within(viewer).findByRole('img', { name: 'Meter photos: Photo 1' }),
    ).toHaveAttribute('src', 'https://files.example/00000000-0000-4000-8000-000000000001.jpg');
    await user.click(within(viewer).getByRole('button', { name: 'Zoom in' }));
    expect(within(viewer).getByText('150%')).toBeInTheDocument();
    await user.click(within(viewer).getByRole('button', { name: /Next/u }));
    expect(await screen.findByRole('dialog', { name: /Photo 2 of 2/u })).toBeInTheDocument();
    expect(within(viewer).getByText('100%')).toBeInTheDocument();
    expect(within(viewer).getByRole('link', { name: 'Open original' })).toHaveAttribute(
      'href',
      'https://files.example/00000000-0000-4000-8000-000000000002.jpg',
    );
    await user.click(within(viewer).getByRole('button', { name: 'Close' }));
  });
});
