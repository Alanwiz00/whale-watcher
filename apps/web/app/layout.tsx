import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'WhaleWatcher · World Cup 2026',
  description: 'Prediction-market whale & smart-money intelligence',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/wallets', label: 'Wallets' },
  { href: '/markets', label: 'Markets' },
  { href: '/arbitrage', label: 'Arbitrage' },
  { href: '/live', label: 'Live Feed' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              🐋 Whale<span>Watcher</span>
            </div>
            <nav className="nav">
              {NAV.map((n) => (
                <a key={n.href} href={n.href}>
                  {n.label}
                </a>
              ))}
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
