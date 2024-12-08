import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import recommendedConfig from "eslint-plugin-prettier/recommended";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["dist/*"],
  },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  recommendedConfig,
];
