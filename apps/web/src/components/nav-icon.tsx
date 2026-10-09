import type { NavIcon } from '@integr8/core';
import type { SVGProps } from 'react';

/**
 * The menu's icons, drawn by hand.
 *
 * Twenty-odd simple strokes on a 24-point grid, so the shell needs no icon
 * library and the bundle carries only the glyphs the menu uses. Each is
 * decorative — the label beside it, or the tooltip when the menu is collapsed,
 * carries the meaning — so every one is `aria-hidden`.
 *
 * Nothing here points left or right. An arrow that must mirror in Arabic is
 * `ArrowBack`, which turns itself round under `[dir=rtl]`.
 */

const PATHS: Readonly<Record<NavIcon, string>> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  clipboard: 'M9 4h6v3H9zM9 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3',
  pen: 'M4 20h4l11-11-4-4L4 16zM13 7l4 4',
  inbox:
    'M4 13h5l1 2h4l1-2h5M4 13V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v7M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  briefcase:
    'M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM3 12h18',
  users:
    'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6',
  'map-pin': 'M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  upload: 'M12 16V5M8 9l4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  tag: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  palette:
    'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1 3.5c.5 1 0 2.5-3 2.5zM8 12h.01M11 8h.01M15 9h.01',
  'user-plus': 'M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 20a6 6 0 0 1 12 0M19 8v6M16 11h6',
  building:
    'M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 9h3a1 1 0 0 1 1 1v11M3 21h18M8 7h.01M12 7h.01M8 11h.01M12 11h.01M8 15h.01M12 15h.01',
  database:
    'M12 9c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  'credit-card':
    'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10h18M7 15h4',
  rocket: 'M12 3c3 2 5 6 5 10l2 3-4-1-3 3-3-3-4 1 2-3c0-4 2-8 5-10zM12 11h.01M9 20l3 1 3-1',
  funnel: 'M4 5h16l-6 7v6l-4 2v-8z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  flag: 'M6 21V4M6 4h11l-2 4 2 4H6',
  megaphone:
    'M4 10v4a1 1 0 0 0 1 1h3l8 4V5L8 9H5a1 1 0 0 0-1 1zM19 10a3 3 0 0 1 0 4M8 15l1 5h3l-1-5',
  layout: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10h16M10 10v10',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
};

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'd'>;

function Glyph({ d, className, ...rest }: GlyphProps & { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'size-5 shrink-0'}
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

/** A section's icon, by the name the navigation model gives it. */
export function NavIconGlyph({ name, ...rest }: GlyphProps & { name: NavIcon }) {
  return <Glyph d={PATHS[name]} {...rest} />;
}

export function MenuIcon(props: GlyphProps) {
  return <Glyph d="M4 7h16M4 12h16M4 17h16" {...props} />;
}

export function CloseIcon(props: GlyphProps) {
  return <Glyph d="M6 6l12 12M18 6L6 18" {...props} />;
}

/** The collapse chevrons: pointing in, in whichever direction the menu is. */
export function CollapseIcon(props: GlyphProps) {
  return <Glyph d="M11 7l-5 5 5 5M18 7l-5 5 5 5" {...props} />;
}

export function ExpandIcon(props: GlyphProps) {
  return <Glyph d="M13 7l5 5-5 5M6 7l5 5-5 5" {...props} />;
}

export function SignOutIcon(props: GlyphProps) {
  return <Glyph d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l5 4-5 4M20 12H9" {...props} />;
}

export function GlobeIcon(props: GlyphProps) {
  return (
    <Glyph
      d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"
      {...props}
    />
  );
}

/**
 * Points back. Drawn pointing left and turned round under `[dir=rtl]`, since
 * "back" is towards the start of the line in either direction.
 */
export function ArrowBack(props: GlyphProps) {
  return <Glyph d="M19 12H5M11 6l-6 6 6 6" className="size-5 shrink-0 rtl:rotate-180" {...props} />;
}
