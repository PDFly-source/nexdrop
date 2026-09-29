import type { NextConfig } from 'next';

/**
 * NexDrop is a 100% client-side PWA hosted on GitHub Pages.
 *
 * Repository: https://github.com/PDFly-source/nexdrop
 * Pages URL:  https://pdfly-source.github.io/nexdrop/
 *
 * The basePath MUST match the repository name so static assets resolve under
 * the project-pages subpath. For local development run `npm run dev` and
 * open http://localhost:3000/nexdrop
 */
const BASE_PATH = '/nexdrop';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: BASE_PATH,
  trailingSlash: true,
  images: {
    // Required for static export (no server-side image optimization exists).
    unoptimized: true,
  },
  eslint: {
    // Lint runs explicitly in CI (`npm run lint`) before the build.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
