import type { NavIcon } from '@integr8/core';
import type { SVGProps } from 'react';

/**
 * The menu's icons, drawn here.
 *
 * Twenty-odd simple stroke glyphs on a 24-unit grid: the shared model names
 * each section's icon (`NavIcon`) and this file is the one place that name
 * becomes a picture. No icon library — one dependency for two dozen lines of
 * path data is one dependency too many for the desktop binary — and every
 * glyph is `currentColor`, so it reads on any shell colour a company chooses.
 *
 * `ChromeIcon` covers what the frame itself needs: a menu, a cross, a chevron
 * and an arrow. The arrow points to the start side; the caller mirrors it in a
 * right-to-left layout with `rtl:-scale-x-100`.
 */

type Glyph = readonly string[];

const NAV_GLYPHS: Record<NavIcon, Glyph> = {
  home: ['M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  clipboard: [
    'M9 4h6M8 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2',
    'M9 11h6M9 15h4',
  ],
  pen: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  inbox: ['M3 13h5l2 3h4l2-3h5', 'M5 5h14l2 8v6H3v-6z'],
  briefcase: [
    'M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M3 13h18',
  ],
  users: [
    'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z',
    'M2 20a7 7 0 0 1 14 0',
    'M16 4.5a3.5 3.5 0 0 1 0 7',
    'M18 13.5a6 6 0 0 1 4 6.5',
  ],
  'map-pin': [
    'M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z',
    'M14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  ],
  upload: ['M12 16V4', 'M6 10l6-6 6 6', 'M4 20h16'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M12 7v5l3 3'],
  tag: [
    'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z',
    'M9 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  ],
  palette: [
    'M12 3a9 9 0 1 0 0 18c1.7 0 2.5-1 2.5-2s-.6-1.5-.6-2.5c0-1.2 1-2 2.1-2H18a3 3 0 0 0 3-3A8.5 8.5 0 0 0 12 3z',
    'M8.5 10.5h.01M12 7.5h.01M15.5 10.5h.01',
  ],
  'user-plus': [
    'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z',
    'M2 20a7 7 0 0 1 14 0',
    'M19 8v6M16 11h6',
  ],
  building: [
    'M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17',
    'M3 21h18',
    'M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
    'M10 21v-3h4v3',
  ],
  database: [
    'M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3z',
    'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ],
  'credit-card': [
    'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z',
    'M2 10h20',
    'M6 15h4',
  ],
  rocket: [
    'M12 2c3 3 4 7 3 12l-3 3-3-3C8 9 9 5 12 2z',
    'M9 14l-4 2 1-4',
    'M15 14l4 2-1-4',
    'M13.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  ],
  funnel: ['M3 4h18l-7 8v6l-4 2v-8z'],
  list: ['M8 6h13M8 12h13M8 18h13', 'M3 6h.01M3 12h.01M3 18h.01'],
  flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
  megaphone: [
    'M3 11v2a1 1 0 0 0 1 1h2l5 4V6l-5 4H4a1 1 0 0 0-1 1z',
    'M15 9a4 4 0 0 1 0 6',
    'M18 6a8 8 0 0 1 0 12',
  ],
  layout: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M3 9h18M9 21V9',
  ],
  package: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],
  heart: ['M12 21s-8-5.3-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.7-8 11-8 11z'],
};

export type ChromeIcon =
  'menu' | 'close' | 'chevron-start' | 'chevron-end' | 'arrow-start' | 'sign-out' | 'globe';

const CHROME_GLYPHS: Record<ChromeIcon, Glyph> = {
  menu: ['M4 7h16M4 12h16M4 17h16'],
  close: ['M6 6l12 12M18 6L6 18'],
  'chevron-start': ['M15 6l-6 6 6 6'],
  'chevron-end': ['M9 6l6 6-6 6'],
  'arrow-start': ['M19 12H5', 'M11 6l-6 6 6 6'],
  'sign-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  globe: [
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    'M3 12h18',
    'M12 3a14 14 0 0 1 0 18A14 14 0 0 1 12 3z',
  ],
};

interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  size?: number;
}

function Glyph({ paths, size = 20, ...rest }: GlyphProps & { paths: Glyph }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The icon the shared menu model names for a section. Decorative; the label beside it carries the meaning. */
export function NavIconGlyph({ name, ...rest }: GlyphProps & { name: NavIcon }) {
  return <Glyph paths={NAV_GLYPHS[name]} {...rest} />;
}

/** The frame's own icons. */
export function ChromeIconGlyph({ name, ...rest }: GlyphProps & { name: ChromeIcon }) {
  return <Glyph paths={CHROME_GLYPHS[name]} {...rest} />;
}
