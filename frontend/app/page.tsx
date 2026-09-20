import Link from "next/link";

const PANELS = [
  {
    href: "/dashboard/sales",
    title: "Ventas y Rendimiento",
    description: "217.451 € facturados en 2026 · 8.371 pedidos únicos · Análisis por país y cumplimiento.",
    badge: "217k €",
    badgeColor: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  },
  {
    href: "/dashboard/inventory",
    title: "Inventario y Logística (FBA)",
    description: "3.904 SKUs en FBA · 744 unidades disponibles · 234 en camino.",
    badge: "1.102 uds",
    badgeColor: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  },
  {
    href: "/listings",
    title: "Catálogo de Productos",
    description: "Gestión y búsqueda de productos, SKUs, ASINs y enlaces a Amazon.",
    badge: "Activo",
    badgeColor: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
  },
  {
    href: "/dashboard/pricing",
    title: "Buy Box y Precios",
    description: "Monitorización de precios competitivos y estado de la oferta destacada.",
    badge: "Monitor",
    badgeColor: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  },
  {
    href: "/dashboard/finance",
    title: "Finanzas y P&L Unitario",
    description: "Comisiones por referencia, tarifas logísticas y margen neto.",
    badge: "Finanzas",
    badgeColor: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  },
  {
    href: "/dashboard/account-health",
    title: "Salud de Cuenta",
    description: "Ratios de envíos tardíos, defectos de pedidos y métricas de rendimiento.",
    badge: "Saludable",
    badgeColor: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  },
  {
    href: "/dashboard/sync",
    title: "Sincronización en Segundo Plano",
    description: "Worker automático programado para refrescar inventario FBA, ventas y finanzas.",
    badge: "Auto-Sync",
    badgeColor: "text-teal-400 bg-teal-500/10 border-teal-500/20",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl p-10">
      <div className="flex items-center justify-between border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-100">Panel de Control Seller</h1>
          <p className="mt-2 text-slate-400">
            Conexión en directo con Amazon SP-API para <span className="text-slate-200 font-semibold">ROCKING GIFTS</span> (España y Europa).
          </p>
        </div>
        <div className="flex items-center gap-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded-full text-xs font-semibold">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          SP-API Conectada
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {PANELS.map((panel) => (
          <Link
            key={panel.href}
            href={panel.href}
            className="group relative flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/40 p-6 hover:border-slate-700 hover:bg-slate-900/80 transition-all shadow-sm"
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${panel.badgeColor}`}>
                  {panel.badge}
                </span>
                <span className="text-slate-600 group-hover:text-slate-400 transition-colors">→</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-100 group-hover:text-indigo-400 transition-colors">
                {panel.title}
              </h2>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                {panel.description}
              </p>
            </div>
            <div className="mt-5 pt-3 border-t border-slate-800/60 text-xs font-medium text-indigo-400">
              Abrir módulo ↗
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
