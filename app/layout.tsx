import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://pdfly-source.github.io/nexdrop/';

export const viewport: Viewport = {
  themeColor: '#070B0C',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'NexDrop — Private, Direct, Fast',
    template: '%s · NexDrop',
  },
  description:
    'Private, direct P2P file and text sharing between devices. No accounts, no cloud uploads — transfers go straight from device to device.',
  applicationName: 'NexDrop',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'NexDrop',
  },
  icons: {
    icon: '/nexdrop/icons/icon.svg',
    apple: '/nexdrop/apple-touch-icon.png',
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'NexDrop — Private, Direct, Fast',
    description:
      'Private, direct P2P file and text sharing between devices. No accounts, no cloud uploads.',
    type: 'website',
    url: SITE_URL,
    siteName: 'NexDrop',
  },
  twitter: {
    card: 'summary',
    title: 'NexDrop — Private, Direct, Fast',
    description:
      'Private, direct P2P file and text sharing between devices. No accounts, no cloud uploads.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark bg-nd-bg-0 text-nd-text-primary">
      <body className="bg-nd-bg-0 text-nd-text-primary antialiased min-h-screen">
        {/* Pre-paint gateway hint: on a bare "/" visit (no hash) the prerendered
            WebApp shell is hidden until React mounts the premium gateway (see
            components/gateway/Gateway.tsx). Any hash (#/home, #join=…) leaves
            the WebApp visible exactly as before. Runs before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){function u(){document.documentElement.classList.toggle('nd-gateway',location.hash==='')}u();addEventListener('hashchange',u)})();",
          }}
        />
        {children}
      </body>
    </html>
  );
}
