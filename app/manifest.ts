import type { MetadataRoute } from 'next';

// Required for `output: 'export'` — the manifest must be statically generated.
export const dynamic = 'force-static';

const BASE_PATH = '/nexdrop';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: `${BASE_PATH}/`,
    name: 'NexDrop — P2P File & Text Sharing',
    short_name: 'NexDrop',
    description:
      'Private, direct, fast P2P file and text sharing. No accounts, no cloud uploads — devices connect directly.',
    start_url: `${BASE_PATH}/`,
    scope: `${BASE_PATH}/`,
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0B0D0F',
    theme_color: '#0B0D0F',
    categories: ['utilities', 'productivity'],
    icons: [
      {
        src: `${BASE_PATH}/icons/icon-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${BASE_PATH}/icons/icon-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${BASE_PATH}/icons/icon-maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
