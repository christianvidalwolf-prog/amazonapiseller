import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { NavLink } from "@/components/NavLink";
import { CompanyBadge, PrivacyToggleButton } from "@/components/PrivacyToggleButton";
import { PrivacyProvider } from "@/lib/PrivacyContext";

const NAV_TAB = "hover:text-slate-100 hover:bg-slate-800/60 transition-colors px-2 py-1 rounded-md shrink-0";
const ACTIVE_TAB = "bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/50 font-semibold";

export const metadata: Metadata = {
  title: "Amazon Seller Ops",
  description: "Panel de gestión integral de cuentas Amazon Seller Central",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen flex flex-col">
        <PrivacyProvider>
          <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-[3.5rem] py-2 flex flex-wrap items-center justify-between gap-y-2">
              <div className="flex items-center gap-3">
                <Link href="/" className="font-bold text-sm sm:text-base text-slate-100 flex items-center gap-2 shrink-0">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Amazon Seller Ops
                  <CompanyBadge />
                </Link>
                <PrivacyToggleButton />
              </div>
              <nav className="flex items-center gap-1 sm:gap-1.5 lg:gap-2 text-xs sm:text-sm text-slate-400 overflow-x-auto py-0.5">
                <NavLink href="/dashboard/sales" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Ventas
                </NavLink>
                <NavLink href="/dashboard/advertising" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Publicidad
                </NavLink>
                <NavLink href="/dashboard/inventory" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Inventario
                </NavLink>
                <NavLink href="/dashboard/finance" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Finanzas
                </NavLink>
                <NavLink href="/dashboard/pricing" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Precios
                </NavLink>
                <NavLink href="/dashboard/bsr" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  BSR
                </NavLink>
                <NavLink href="/dashboard/account-health" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Salud Cuenta
                </NavLink>
                <NavLink href="/listings" className={NAV_TAB} activeClassName={ACTIVE_TAB}>
                  Catálogo
                </NavLink>
                <NavLink
                  href="/dashboard/sync"
                  className="hover:text-emerald-300 hover:bg-emerald-950/40 transition-colors px-2 py-1 rounded-md flex items-center gap-1 text-emerald-400 font-medium shrink-0"
                  activeClassName="bg-emerald-500/15 ring-1 ring-emerald-500/50 text-emerald-300"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  Auto-Sync
                </NavLink>
              </nav>
            </div>
          </header>
          <div className="flex-1">{children}</div>
        </PrivacyProvider>
      </body>
    </html>
  );
}
