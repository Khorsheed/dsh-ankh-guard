import { afterEach, describe, expect, it, vi } from 'vitest'

// Dual-name probe against a host that installs NEITHER name (a preset-less
// host, and the shape a broken install tree takes): both dynamic imports
// reject, and the loader must settle null instead of throwing — the
// derivation then receives `{}`, the established no-preset degrade.
const attempts = vi.hoisted(() => ({ registry: 0, presets: 0 }))
vi.mock('@deepseek-ai/dsh-agent-preset-registry', () => {
  attempts.registry += 1
  throw new Error('Cannot find package (new name not installed)')
})
vi.mock('@deepseek-ai/dsh-agent-presets', () => {
  attempts.presets += 1
  throw new Error('Cannot find package (old name not installed)')
})

import { deriveSessionPreset, loadPresetRegistry, resetPresetRegistryProbeForTest } from '../src/index.ts'

describe('loadPresetRegistry with neither registry name installed', () => {
  afterEach(() => { resetPresetRegistryProbeForTest() })

  it('resolves null instead of throwing when both names reject', async () => {
    await expect(loadPresetRegistry()).resolves.toBeNull()
    expect(attempts).toEqual({ registry: 1, presets: 1 })
  })

  it('caches the probe across calls, and the reset seam re-runs it', async () => {
    const before = { ...attempts }
    await loadPresetRegistry()
    await loadPresetRegistry()
    expect(attempts).toEqual({ registry: before.registry + 1, presets: before.presets + 1 })
    resetPresetRegistryProbeForTest()
    await loadPresetRegistry()
    expect(attempts).toEqual({ registry: before.registry + 2, presets: before.presets + 2 })
  })

  it('the null probe degrades the derivation exactly like an empty surface', async () => {
    const host = await loadPresetRegistry()
    const session = {
      header: { agentPreset: 'from-header' },
      events: [{ type: 'agent-preset/selected', data: { agentPreset: 'switched' } }],
    }
    expect(deriveSessionPreset((host ?? {}) as Parameters<typeof deriveSessionPreset>[0], session)).toBeUndefined()
  })
})
