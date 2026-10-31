import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { googleMapsUrl, SiteLocation } from './site-location.js';
import { fakeApi, renderScreen } from './testing/render.js';

/**
 * Where a site is (P10), without a map drawn on screen: the coordinates, a
 * link to check them in Google Maps, and typed coordinates to correct them.
 */

const CAIRO = { latitude: 30.0444, longitude: 31.2357 };

describe('a site’s location', () => {
  it('shows the coordinates with a Google Maps link to check them, and no map', () => {
    const { client } = fakeApi({});
    const { container } = renderScreen(
      <SiteLocation
        location={CAIRO}
        status="found"
        accuracy="address"
        editable={false}
        onSave={() => Promise.resolve()}
      />,
      client,
    );

    expect(screen.getByText('30.0444, 31.2357')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open in Google Maps' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=30.0444,31.2357',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.leaflet-container')).toBeNull();
    // Read-only: nothing to change it with.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no link before there is a position', () => {
    const { client } = fakeApi({});
    renderScreen(
      <SiteLocation
        location={null}
        status="not_found"
        accuracy={null}
        editable
        onSave={() => Promise.resolve()}
      />,
      client,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('could not be found');
  });

  it('saves coordinates typed by hand', async () => {
    const { client } = fakeApi({});
    const onSave = vi.fn(() => Promise.resolve());
    renderScreen(
      <SiteLocation location={null} status="failed" accuracy={null} editable onSave={onSave} />,
      client,
    );

    await userEvent.type(screen.getByLabelText('Latitude'), '30.0444');
    await userEvent.type(screen.getByLabelText('Longitude'), '31.2357');
    await userEvent.click(screen.getByRole('button', { name: 'Save this position' }));
    expect(onSave).toHaveBeenCalledWith(CAIRO);
  });

  it('builds the link in Arabic too, with the numbers left to right', () => {
    const { client } = fakeApi({});
    renderScreen(
      <SiteLocation
        location={CAIRO}
        status="manual"
        accuracy={null}
        editable={false}
        onSave={() => Promise.resolve()}
      />,
      client,
      { locale: 'ar' },
    );
    expect(screen.getByRole('link', { name: 'فتح في خرائط Google' })).toHaveAttribute(
      'href',
      googleMapsUrl(CAIRO),
    );
    expect(screen.getByText('30.0444, 31.2357')).toHaveAttribute('dir', 'ltr');
  });
});
