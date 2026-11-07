/**
 * Añade un SKU existente como hijo de una familia de variantes (parent/child) de Amazon.
 * Solo toca los atributos de variación: parentage_level, child_parent_sku_relationship,
 * variation_theme y el valor de la dimensión (color o size). No cambia precio, stock ni contenido.
 *
 * Uso (desde backend/):
 *   npx tsx scripts/variantes/attach-child.ts <SKU_HIJO> <SKU_PADRE> <TEMA> <VALOR> [ES]
 *     TEMA  = COLOR | SIZE | COLOR/SIZE | SIZE/COLOR
 *     VALOR = etiqueta de la variante (p. ej. "Blanco Nórdico")
 *     --apply      envía (sin él solo valida con VALIDATION_PREVIEW)
 *     --force      permite mover un hijo que ya está en otra familia
 *
 * Ejemplo:
 *   npx tsx scripts/variantes/attach-child.ts 40273SGI relojpared60cm COLOR "Blanco Nórdico"
 *   npx tsx scripts/variantes/attach-child.ts 40273SGI relojpared60cm COLOR "Blanco Nórdico" --apply
 */
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";

const client = new SpApiClient({ credentials: env.spApi });
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const APPLY = flags.has("--apply");
const FORCE = flags.has("--force");

const [childSku, parentSku, themeArg, value, code = "ES"] = args;
const theme = (themeArg ?? "").toUpperCase();
const mid = EU_MARKETPLACES[code.toUpperCase()]?.id;

if (!childSku || !parentSku || !theme || !value || !mid) {
  console.error("Uso: attach-child.ts <SKU_HIJO> <SKU_PADRE> <COLOR|SIZE|COLOR/SIZE|SIZE/COLOR> <VALOR> [ES] [--apply] [--force]");
  process.exit(2);
}
if (!["COLOR", "SIZE", "COLOR/SIZE", "SIZE/COLOR"].includes(theme)) {
  console.error(`Tema no válido: ${theme}`);
  process.exit(2);
}

const isNotFound = (e: unknown) => /NOT_FOUND|not found|404/i.test(String(e));
/** Idioma de los atributos de texto por marketplace (Amazon rechaza con 100720 si no coincide). */
const LANGUAGE: Record<string, string> = { ES: "es_ES", DE: "de_DE", FR: "fr_FR", IT: "it_IT" };
const LANG = LANGUAGE[code.toUpperCase()] ?? "es_ES";
const v = (value: unknown) => [{ value, marketplace_id: mid }];
const vl = (value: string) => [{ value, language_tag: LANG, marketplace_id: mid }];
const first = (x: any) => (Array.isArray(x) ? x[0] : x);
const val = (x: any) => first(x)?.value ?? null;

async function get(sku: string) {
  try {
    return await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid!], includedData: ["summaries", "attributes", "issues"], issueLocale: "es_ES" });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function patch(sku: string, body: unknown, preview: boolean) {
  return client.request<any>({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid!, issueLocale: "es_ES", ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
    body,
    rateLimitKey: "listingsItems.patchListingsItem",
  });
}

const errorsOf = (r: any) => (r?.issues ?? []).filter((i: any) => i.severity === "ERROR");

async function main() {
  const [child, parent] = await Promise.all([get(childSku), get(parentSku)]);
  if (!child) throw new Error(`${childSku} no existe en ${code}`);
  if (!parent) throw new Error(`El padre ${parentSku} no existe en ${code}`);

  const attrs = (child.attributes ?? {}) as Record<string, any>;
  const pAttrs = (parent.attributes ?? {}) as Record<string, any>;
  const parentTheme = first(pAttrs.variation_theme)?.name;
  const parentLevel = val(pAttrs.parentage_level) ?? first(pAttrs.parentage_level)?.value;
  if (parentLevel !== "parent") throw new Error(`${parentSku} no es un padre (parentage_level=${parentLevel ?? "null"})`);
  if (parentTheme && parentTheme.toUpperCase() !== theme) {
    throw new Error(`El padre usa el tema ${parentTheme} y se ha pedido ${theme}`);
  }

  const currentParent = first(attrs.child_parent_sku_relationship)?.parent_sku ?? null;
  if (currentParent && currentParent !== parentSku && !FORCE) {
    throw new Error(`${childSku} ya es hijo de ${currentParent}; usa --force para moverlo`);
  }

  const patches: any[] = [
    { op: "replace", path: "/attributes/parentage_level", value: v("child") },
    {
      op: "replace",
      path: "/attributes/child_parent_sku_relationship",
      value: [{ child_relationship_type: "variation", parent_sku: parentSku, marketplace_id: mid }],
    },
    { op: "replace", path: "/attributes/variation_theme", value: [{ name: theme, marketplace_id: mid }] },
  ];

  // Las dos dimensiones del tema llevan el mismo valor salvo en COLOR/SIZE, donde el tamaño es el del producto.
  if (theme.includes("COLOR")) patches.push({ op: "replace", path: "/attributes/color", value: vl(value) });
  if (theme.includes("SIZE")) {
    const size = val(attrs.size) ?? value;
    patches.push({ op: "replace", path: "/attributes/size", value: vl(size) });
  }

  // SCULPTURE exige `power_plug_type` en cada PATCH (los relojes de pared no llevan enchufe).
  const productType = first(child.summaries)?.productType ?? "PRODUCT";
  if (productType === "SCULPTURE") {
    patches.push({
      op: "replace",
      path: "/attributes/power_plug_type",
      value: attrs.power_plug_type ?? v("no_plug"),
    });
  }

  const body = { productType, patches };
  console.log(
    JSON.stringify({
      child: childSku,
      parent: parentSku,
      parentTheme,
      theme,
      value,
      currentParent,
      currentParentage: val(attrs.parentage_level),
      apply: APPLY,
    }),
  );

  const preview = await patch(childSku, body, true);
  const previewErrors = errorsOf(preview);
  console.log(`preview ${preview.status}${previewErrors.length ? ` · ${previewErrors.map((i: any) => `${i.code} ${i.message}`).join(" | ").slice(0, 500)}` : ""}`);
  if (previewErrors.length) process.exit(1);
  if (!APPLY) {
    console.log("simulación: no se ha enviado (añade --apply)");
    return;
  }

  const res = await patch(childSku, body, false);
  const errs = errorsOf(res);
  console.log(`envío ${res.status}${errs.length ? ` · ${errs.map((i: any) => `${i.code} ${i.message}`).join(" | ").slice(0, 500)}` : ""}`);

  const after = await get(childSku);
  const aAttrs = (after?.attributes ?? {}) as Record<string, any>;
  console.log(
    JSON.stringify({
      after: {
        parentage: val(aAttrs.parentage_level),
        parentSku: first(aAttrs.child_parent_sku_relationship)?.parent_sku ?? null,
        theme: first(aAttrs.variation_theme)?.name ?? null,
        color: val(aAttrs.color),
        status: first(after?.summaries)?.status ?? [],
      },
    }),
  );
  if (res.status !== "ACCEPTED") process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e));
    process.exit(1);
  },
);
