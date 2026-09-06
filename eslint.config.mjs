import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Dev-only plain-Node scripts (not part of the Next.js/TypeScript app code) -- e.g.
    // scripts/test-phase6.js, a scripted Socket.io test run directly with `node`, not tsx/tsc.
    "scripts/**",
  ]),
]);

export default eslintConfig;
