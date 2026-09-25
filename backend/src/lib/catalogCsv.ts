import fs from "node:fs";

/**
 * Lee catalogo_completo.csv reparando el texto mal decodificado.
 *
 * Versiones anteriores de get_full_catalog.py decodificaban como latin1 un
 * informe que Amazon envía en UTF-8 ("Decoración" → "DecoraciÃ³n"), y CI
 * conserva ese fichero en caché. Cada línea se vuelve a sus bytes latin1 y se
 * relee como UTF-8; si eso no da UTF-8 válido, la línea ya estaba bien.
 */
export function readCatalogCsvLines(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(repairMojibake)
    .map((line, i) => (i === 0 ? line.replace(/^﻿/, "") : line));
}

function repairMojibake(line: string): string {
  // Solo aplica a líneas con caracteres 0x80–0xFF y ninguno por encima (latin1 puro).
  if (!/[\u0080-ÿ]/.test(line) || /[^\u0000-ÿ]/.test(line)) return line;
  const repaired = Buffer.from(line, "latin1").toString("utf-8");
  return repaired.includes("�") ? line : repaired;
}
