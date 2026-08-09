import typescript from 'rollup-plugin-typescript2';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import webWorkerLoader from 'rollup-plugin-web-worker-loader';
import svelte from 'rollup-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';

export default {
  input: 'src/main.ts',
  output: {
    file: 'main.js',
    format: 'cjs',
    sourcemap: true,
    inlineDynamicImports: true
  },
  external: ['obsidian', 'child_process', 'fs', 'http', 'https', 'mammoth'],
  plugins: [
    webWorkerLoader({
      targetPlatform: 'browser',
      inline: true,
      sourcemap: true,
      extensions: ['.ts', '.js'],
      plugins: [
        typescript({
          tsconfig: "tsconfig.json",
          clean: true,
          verbosity: 1,
          abortOnError: false
        }),
        nodeResolve({ 
          browser: true,
          preferBuiltins: false
        }),
        commonjs()
      ]
    }),
    svelte({
      emitCss: false,
      preprocess: sveltePreprocess({
        typescript: {
          compilerOptions: {
            verbatimModuleSyntax: true,
          },
        },
      }),
      compilerOptions: {
        compatibility: {
          componentApi: 4
        }
      }
    }),
    typescript(),
    nodeResolve({ 
      browser: true,
      preferBuiltins: false
    }),
    commonjs(),
    json()
  ]
};
