import resolve from "@rollup/plugin-node-resolve";

export default {
  input: "dist/index.js",
  output: {
    dir: "public/dev",
    format: "esm",
    preserveModules: true,
    preserveModulesRoot: "dist",
  },
  plugins: [resolve()],
};
