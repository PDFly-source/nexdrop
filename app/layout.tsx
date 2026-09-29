import type { Metadata, Viewport } from 'next';
import fs from 'fs';
import path from 'path';

let cachedCss = '';
function getGlobalCss() {
  if (!cachedCss) {
    try {
      const p = path.join(process.cwd(), 'public/globals.css');
      if (fs.existsSync(p)) {
        cachedCss = fs.readFileSync(p, 'utf8');
      }
    } catch (_) {}
  }
  return cachedCss;
}

export const viewport: Viewport = {
  themeColor: '#0B0D0F',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: 'NexDrop — Private, Direct, Fast P2P Sharing',
  description:
    'Private, direct, fast P2P file and text sharing powered by WebRTC. No accounts, no cloud uploads, completely decentralized device-to-device transfers.',
  applicationName: 'NexDrop',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'NexDrop',
  },
  icons: {
    icon: '/icons/icon.svg',
    apple: '/apple-touch-icon.png',
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'NexDrop — Private, Direct, Fast P2P Sharing',
    description:
      'Transfer files, photos, videos, documents and text directly between your devices using WebRTC. No account, no cloud upload, private by design.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NexDrop — Private, Direct, Fast P2P Sharing',
    description:
      'Transfer files, photos, videos, documents and text directly between your devices using WebRTC. No account, no cloud upload, private by design.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const css = getGlobalCss();
  return (
    <html lang="en" className="dark bg-[#0B0D0F] text-[#F5F7F8]">
      <head>
        {css ? (
          <style
            id="nexdrop-tailwind"
            dangerouslySetInnerHTML={{ __html: css }}
          />
        ) : null}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/globals.css" />
      </head>
      <body suppressHydrationWarning className="bg-[#0B0D0F] text-[#F5F7F8] antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
