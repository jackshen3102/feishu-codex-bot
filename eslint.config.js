import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "docs/prototypes/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/web/public/*.js"],
    languageOptions: { globals: { document: "readonly", window: "readonly", location: "readonly", history: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly", Headers: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly" } },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
