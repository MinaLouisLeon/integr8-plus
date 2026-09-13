/**
 * Tailwind v4 is a PostCSS plugin and needs no configuration file of its own:
 * the theme comes from `@theme inline` in `@integr8/tokens/theme.css`, so the
 * design system has one home rather than two that drift.
 */
const config = {
  plugins: { '@tailwindcss/postcss': {} },
};

export default config;
