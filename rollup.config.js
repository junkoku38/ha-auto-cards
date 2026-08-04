import resolve from "@rollup/plugin-node-resolve";
import { terser } from "rollup-plugin-terser";

export default {
  input: "src/comfort-card.js",
  output: {
    file: "dist/auto-cards.js",
    format: "iife",
    name: "AutoCards",
    sourcemap: true,
  },
  plugins: [resolve(), terser()],
};