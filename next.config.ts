import path from "node:path";
import type { NextConfig } from "next";

// This folder is the project root. Pinned because Next otherwise picks the
// highest folder with a lockfile, and a package-lock.json further up (e.g. in
// the home folder) would make that the workspace root.
const projectRoot = path.resolve(__dirname);

// cacheComponents and partialPrefetching stay off on purpose (both default to
// off): every page is per-user and dynamic, so there is nothing to prerender.
const nextConfig: NextConfig = {
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
    // Tailwind v4 runs through this loader; there is no PostCSS config.
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
