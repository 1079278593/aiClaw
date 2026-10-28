// eslint.config.mjs
export default [
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      // Add ESLint rules here
    },
  },
];
