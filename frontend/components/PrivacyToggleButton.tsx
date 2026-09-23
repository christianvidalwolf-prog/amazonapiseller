"use client";

import React from "react";
import { usePrivacy } from "@/lib/PrivacyContext";

export function PrivacyToggleButton() {
  const { isPrivacyMode, togglePrivacyMode } = usePrivacy();

  return (
    <button
      type="button"
      onClick={togglePrivacyMode}
      title={
        isPrivacyMode
          ? "Modo Privacidad Activo: Los datos sensibles de empresa, productos, SKUs y ASINs están anonimizados para demostración a clientes. Pulsa para volver a datos reales."
          : "Activar Modo Privacidad / Demo Cliente (Estilo Shopkeeper): Anonimiza la empresa y productos para enseñar la app sin revelar tus productos reales."
      }
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
        isPrivacyMode
          ? "bg-purple-950/80 text-purple-300 border-purple-600/80 shadow-[0_0_12px_rgba(168,85,247,0.3)] animate-pulse"
          : "bg-slate-800/80 text-slate-300 border-slate-700/60 hover:bg-slate-800 hover:text-slate-100"
      }`}
    >
      <span className="text-sm">{isPrivacyMode ? "🕵️" : "👁️"}</span>
      <span>{isPrivacyMode ? "Modo Demo ON" : "Modo Demo"}</span>
    </button>
  );
}

export function CompanyBadge() {
  const { isPrivacyMode, maskCompanyName } = usePrivacy();
  const name = maskCompanyName("ROCKING GIFTS");

  return (
    <span
      className={`text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded border transition-colors ${
        isPrivacyMode
          ? "bg-purple-950/90 text-purple-200 border-purple-700"
          : "bg-slate-800 text-slate-400 border-slate-700/50"
      }`}
    >
      {name}
    </span>
  );
}
