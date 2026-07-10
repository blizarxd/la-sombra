import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "La Sombra — Polymarket copy-trading research (paper only)",
  description: "Self-improving copy-trading research bot. Simulated trades only — never real money.",
};

const nav = [
  { href: "/", label: "Overview" },
  { href: "/wallets", label: "Wallet Rankings" },
  { href: "/signals", label: "Trade Signals" },
  { href: "/paper", label: "Paper Trades" },
  { href: "/journal", label: "Decision Journal" },
  { href: "/performance", label: "Performance" },
  { href: "/rules", label: "Rules" },
  { href: "/reports", label: "Reports" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="mx-auto flex min-h-screen max-w-7xl">
          <aside className="hidden w-52 shrink-0 border-r border-edge px-4 py-6 md:block">
            <div className="mb-1 text-lg font-bold tracking-tight">
              La <span className="text-accent">Sombra</span>
            </div>
            <div className="mb-6 text-[11px] leading-4 text-mist">copy-trading research</div>
            <nav className="flex flex-col gap-1">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm text-mist transition hover:bg-panel2 hover:text-bright"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-8 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-[11px] leading-4 text-watch">
              PAPER TRADING ONLY. No real orders, no keys, no money. Not financial advice.
            </div>
          </aside>
          <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
            <div className="mb-4 flex flex-wrap items-center gap-2 md:hidden">
              {nav.map((item) => (
                <Link key={item.href} href={item.href} className="rounded-full border border-edge px-3 py-1 text-xs text-mist">
                  {item.label}
                </Link>
              ))}
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
