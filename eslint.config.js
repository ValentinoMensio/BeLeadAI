const globals = require("globals");

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["icons/**", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.webextensions,
        chrome: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["src/features/**/*.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='message'][object.property.name='error']",
          message:
            "No renderices backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
        {
          selector:
            "MemberExpression[property.name='message'][object.type='ChainExpression'][object.expression.property.name='error']",
          message:
            "No renderices backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
        {
          selector:
            "VariableDeclarator[id.type='ObjectPattern'][init.type='MemberExpression'][init.property.name='error']:has(Property[key.name='message'])",
          message:
            "No destructures backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
        {
          selector:
            "VariableDeclarator[id.type='ObjectPattern'][init.type='ChainExpression'][init.expression.property.name='error']:has(Property[key.name='message'])",
          message:
            "No destructures backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
        {
          selector:
            "AssignmentExpression[left.type='ObjectPattern'][right.type='MemberExpression'][right.property.name='error']:has(Property[key.name='message'])",
          message:
            "No destructures backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
        {
          selector:
            "AssignmentExpression[left.type='ObjectPattern'][right.type='ChainExpression'][right.expression.property.name='error']:has(Property[key.name='message'])",
          message:
            "No destructures backend error.message en UI. Usa errorMessage o un presenter del front.",
        },
      ],
    },
  },
];
