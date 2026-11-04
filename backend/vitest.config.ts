import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/lib/de-shipping-group.test.ts", "scripts/lib/de-buyer-shipping.test.ts"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});
