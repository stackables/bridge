import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      "**/build/**",
      "**/dist/**",
      "**/.astro/**",
      "packages/playground/**",
      "packages/docs-site/**",
    ],
  },

  // ── Base JS rules ────────────────────────────────────────────────
  eslint.configs.recommended,

  // ── TypeScript rules ─────────────────────────────────────────────
  ...tseslint.configs.recommended,

  // ── Rule overrides for TS files ──────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    rules: {
      // TypeScript handles these better than ESLint
      "no-undef": "off",
      "no-redeclare": "off",

      // Allow `any` — the codebase uses it intentionally
      "@typescript-eslint/no-explicit-any": "off",

      // Allow unused vars with _ prefix (matches tsconfig convention)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Allow require() for dynamic imports and CJS interop
      "@typescript-eslint/no-require-imports": "off",

      // Allow `this` aliasing — used by Chevrotain parser
      "@typescript-eslint/no-this-alias": "off",

      // Allow `@ts-ignore` / `@ts-expect-error` comments
      "@typescript-eslint/ban-ts-comment": "off",
    },
  },

  // ── JS build scripts (Node globals are fine) ─────────────────────
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    rules: {
      "no-undef": "off",
    },
  },
);
