import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'NexDrop — P2P File & Text Sharing',
    short_name: 'NexDrop',
    description: 'Private, direct, fast P2P file and text sharing powered by WebRTC. No accounts, no cloud uploads.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0B0D0F',
    theme_color: '#0B0D0F',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
