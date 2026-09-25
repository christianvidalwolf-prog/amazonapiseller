import { expect, test } from "@playwright/test";

test("inventory exposes filters and marketplace selector", async ({ page }) => {
  await page.goto("/dashboard/inventory");
  await expect(page.getByText("Inventario y Logística Global")).toBeVisible();
  await expect(page.getByText("Solo mostrar con stock disponible/activo")).toBeVisible();
  await expect(page.locator("select").first()).toBeVisible();
});
