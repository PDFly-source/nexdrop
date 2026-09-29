/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // Tailwind v4 includes vendor prefixing via its oxide engine —
    // no separate autoprefixer plugin is needed.
    '@tailwindcss/postcss': {},
  },
};

export default config;
