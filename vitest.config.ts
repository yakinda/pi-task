import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
