/**
 * Package-local tsdown config: the root host-pass default emits only
 * lib/types/{index,invariant,startup}.js, but the guard's CLI must ship as a
 * published artifact (lib/cli.js, wired to the `dsh-ankh-guard` bin and the
 * `./cli` export). The companion browser bundle owns original-tab handoff.
 */
import { clientBundle } from '../../build/tsdown.client.ts'

export default clientBundle('@khorsheed/dsh-ankh-guard', [
  'lib/types/{index,invariant,cli,preflight-runner,exit-agent,test-seam,test-seam-cli}.js',
], { hostPhase: true })
