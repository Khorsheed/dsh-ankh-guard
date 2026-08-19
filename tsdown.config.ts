/**
 * Package-local tsdown config: the root host-pass default emits only
 * lib/types/{index,invariant,startup}.js, but the guard's CLI must ship as a
 * published artifact (lib/cli.js, wired to the `dsh-ankh-guard` bin and the
 * `./cli` export). The Client pass emits nothing for this host-side package.
 */
import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => {
  const client = env?.DSH_BUILD_FACE === 'client'
  return {
    entry: client ? '' : ['lib/types/{index,invariant,cli,preflight-runner}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
