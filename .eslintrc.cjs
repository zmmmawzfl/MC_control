module.exports = {
  env: {
    node: true,
    browser: true,
    es2024: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script'
  },
  rules: {
    'no-console': 'off',
    'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
    'no-undef': 'error',
    'no-prototype-builtins': 'off'
  }
};
