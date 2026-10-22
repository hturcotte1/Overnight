import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "spikes/**", "fixtures/**", "**/dist/**", "submission/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
);
