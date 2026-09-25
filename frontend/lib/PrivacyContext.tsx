"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

interface PrivacyContextType {
  isPrivacyMode: boolean;
  togglePrivacyMode: () => void;
  maskCompanyName: (realName?: string) => string;
  maskProductName: (realName?: string, seedKey?: string) => string;
  maskSku: (realSku?: string) => string;
  maskAsin: (realAsin?: string) => string;
}

const PrivacyContext = createContext<PrivacyContextType>({
  isPrivacyMode: false,
  togglePrivacyMode: () => {},
  maskCompanyName: (name) => name || "",
  maskProductName: (name) => name || "",
  maskSku: (sku) => sku || "",
  maskAsin: (asin) => asin || "",
});

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const FICTIONAL_BRANDS = [
  "NORDIC NOVA",
  "ZENITH LABS",
  "AURA LIVING",
  "ECHO AUDIO",
  "LUMINA DESIGN",
  "APEX GEAR",
  "VELOX TECH",
  "SOLIS HOME",
];

const PRODUCT_TYPES = [
  "Auriculares Inalámbricos Pro",
  "Botella Térmica Inox 750ml",
  "Lámpara LED Inteligente RGB",
  "Teclado Mecánico Ergonómico",
  "Mochila Antirrobo Impermeable",
  "Soporte Ajustable Aluminio",
  "Humidificador Difusor Aromas",
  "Cargador Rápido USB-C 65W",
  "Esterilla Yoga Antideslizante",
  "Set Cuchillos Cerámicos Chef",
  "Báscula Digital Inteligente",
  "Altavoz Bluetooth Resistente al Agua",
  "Reloj Inteligente Fitness Pro",
  "Funda Protección Premium Shockproof",
  "Ratón Inalámbrico Recargable",
  "Mini Proyector Portátil HD",
];

const MODIFIERS = [
  "Edición Negro Mate",
  "Pack Ahorro 2 Unidades",
  "Serie Titanium Alta Calidad",
  "Versión 2026 Bluetooth Plus",
  "Diseño Minimalista",
  "Confort Total & Estilo",
];

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const [isPrivacyMode, setIsPrivacyMode] = useState<boolean>(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("demo_privacy_mode");
    if (saved === "true") {
      setIsPrivacyMode(true);
    }
  }, []);

  const togglePrivacyMode = () => {
    setIsPrivacyMode((prev) => {
      const next = !prev;
      localStorage.setItem("demo_privacy_mode", next ? "true" : "false");
      return next;
    });
  };

  const maskCompanyName = (realName?: string): string => {
    if (!isPrivacyMode) return realName || "ROCKING GIFTS";
    return "ACME GLOBAL BRANDS";
  };

  const maskProductName = (realName?: string, seedKey?: string): string => {
    if (!isPrivacyMode) return realName || "-";
    const key = seedKey || realName || "item";
    const hash = hashString(key);
    const brand = FICTIONAL_BRANDS[hash % FICTIONAL_BRANDS.length];
    const type = PRODUCT_TYPES[(hash >> 2) % PRODUCT_TYPES.length];
    const modifier = MODIFIERS[(hash >> 4) % MODIFIERS.length];
    return `${brand} - ${type} (${modifier})`;
  };

  const maskSku = (realSku?: string): string => {
    if (!isPrivacyMode) return realSku || "-";
    if (!realSku) return "DEMO-001";
    const hash = hashString(realSku);
    const prefix = ["GLB", "NOVA", "PRM", "ZEN", "ACME"][hash % 5];
    const num = (hash % 8999) + 1000;
    return `${prefix}-${num}`;
  };

  const maskAsin = (realAsin?: string): string => {
    if (!isPrivacyMode) return realAsin || "-";
    if (!realAsin) return "B09DEMO001";
    const hash = hashString(realAsin);
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let fake = "B0";
    let val = hash;
    for (let i = 0; i < 8; i++) {
      fake += chars[val % chars.length];
      val = Math.floor(val / 7) + 3;
    }
    return fake.slice(0, 10);
  };

  return (
    <PrivacyContext.Provider
      value={{
        isPrivacyMode: mounted ? isPrivacyMode : false,
        togglePrivacyMode,
        maskCompanyName,
        maskProductName,
        maskSku,
        maskAsin,
      }}
    >
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}
