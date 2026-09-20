import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Amazon Seller Ops",
  description: "Panel de gestión integral de cuentas Amazon Seller Central",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen flex flex-col">
        <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-[3.5rem] py-2 flex flex-wrap items-center justify-between gap-y-2">
            <Link href="/" className="font-bold text-sm sm:text-base text-slate-100 flex items-center gap-2 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Amazon Seller Ops
              <span className="text-[10px] sm:text-xs font-normal text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700/50">ROCKING GIFTS</span>
            </Link>
            <nav className="flex items-center gap-1 sm:gap-1.5 lg:gap-2 text-xs sm:text-sm text-slate-400 overflow-x-auto py-0.5">
              <Link href="/dashboard/sales" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Ventas
              </Link>
              <Link href="/dashboard/advertising" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md flex items-center gap-1 shrink-0 text-amber-400/90 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                Publicidad
              </Link>
              <Link href="/dashboard/inventory" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Inventario
              </Link>
              <Link href="/dashboard/finance" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Finanzas
              </Link>
              <Link href="/dashboard/pricing" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Precios
              </Link>
              <Link href="/dashboard/account-health" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Salud Cuenta
              </Link>
              <Link href="/listings" className="hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0">
                Catálogo
              </Link>
              <Link
                href="/dashboard/sync"
                className="hover:text-emerald-300 hover:bg-emerald-950/40 transition-colors px-2 py-1 rounded-md flex items-center gap-1 text-emerald-400 font-medium shrink-0"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                Auto-Sync
              </Link>
            </nav>
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
