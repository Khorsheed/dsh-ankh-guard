import { describe, expect, it } from 'vitest'
import { brokenAgentPresets } from '../src/preflight-runner.ts'

/** A ctx-shaped probe double: `get` answers only the agentPresets key. */
function ctxWith(registry: unknown) {
  return { get: (key: string) => (key === 'agentPresets' ? registry : undefined) }
}

describe('brokenAgentPresets', () => {
  it('degrades to no findings when the registry face is absent or list-less', async () => {
    expect(await brokenAgentPresets({})).toEqual([])
    expect(await brokenAgentPresets(ctxWith(undefined))).toEqual([])
    expect(await brokenAgentPresets(ctxWith({ resolve: async () => ({}) }))).toEqual([])
  })

  it('reports only presets carrying a broken diagnostic, verbatim', async () => {
    const broken = 'worktrees-tool (@khorsheed/dsh-worktrees/tool): never started (gateway/internal)'
    const registry = {
      list: async () => [
        { id: 'standard' },
        { id: 'dev', broken },
        { id: 'eval' },
      ],
    }
    expect(await brokenAgentPresets(ctxWith(registry))).toEqual([{ id: 'dev', broken }])
  })

  it('ignores malformed roster rows instead of inventing verdicts', async () => {
    const registry = {
      list: async () => [
        null,
        { broken: 'no id' },
        { id: 'draft', broken: 42 },
        { id: 'ok' },
      ],
    }
    expect(await brokenAgentPresets(ctxWith(registry))).toEqual([])
  })

  it('propagates a registry read failure — a roster that cannot be read must not pass silently', async () => {
    const registry = { list: async () => { throw new Error('registry gone') } }
    await expect(brokenAgentPresets(ctxWith(registry))).rejects.toThrow('registry gone')
  })
})
