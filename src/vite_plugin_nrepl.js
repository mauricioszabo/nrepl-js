// Vite plugin that applies the nREPL Babel scope-mapper transform.
//
// Add to your vite.config.js:
//   import nreplPlugin from 'nrepl-js/vite-plugin';
//   export default { plugins: [nreplPlugin()] }
//
// enforce: 'pre' ensures this runs before esbuild renames variables,
// so the string literals we bake in reflect the original source names.

import { transform } from '@babel/core';
import babelPluginNrepl from './babel_plugin_nrepl.js';

export default function vitePluginNrepl() {
  return {
    name: 'nrepl-js-scope-mapper',
    enforce: 'pre',
    async transform(code, id) {
      if (!/\.[jt]sx?$/.test(id) || /node_modules/.test(id)) return null;
      const result = await transform(code, {
        filename: id,
        plugins: [babelPluginNrepl],
        sourceMaps: true,
        configFile: false,
        babelrc: false,
      });
      if (!result) return null;
      return { code: result.code, map: result.map };
    },
  };
}
