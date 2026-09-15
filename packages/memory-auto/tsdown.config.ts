import { defineConfig } from 'tsdown'

// fixedExtension: false keeps dist/index.js + index.d.ts. tsdown 0.23 defaults
// it to true on platform "node", which emitted index.mjs + index.d.mts and left
// the package.json main/exports paths pointing at files that never existed.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
})
