import type { NextConfig } from "next";

// cacheComponents and partialPrefetching stay off on purpose (both default to
// off): every page is per-user and dynamic, so there is nothing to prerender.
const nextConfig: NextConfig = {
  // Tailwind v4 runs through this loader; there is no PostCSS config.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
