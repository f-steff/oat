import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated output and non-TS assets are not linted.
  { ignores: ["dist/**", "dist-test/**", "node_modules/**", "research/**", "scripts/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      // Allow intentionally unused args/vars prefixed with underscore.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
