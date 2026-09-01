import { describe, expect, it } from 'vitest'
import * as agentPresetsHost from '@deepseek-ai/dsh-agent-presets'
import { deriveSessionPreset, type PresetDerivationSurface } from '../src/index.ts'

describe('deriveSessionPreset', () => {
  const header = { agentPreset: 'from-header' }
  const events = [
    { type: 'message', data: {} },
    { type: 'agent-preset/selected', data: { agentPreset: 'switched' } },
  ]

  it('folds through the projection surface when the host carries one (0.1.2 line)', () => {
    const surface = {
      agentPresetProjectionDefinition: {
        init: (h: { agentPreset?: string | null }) => h.agentPreset ?? null,
        apply: (state: string | null, event: { type: string; data?: unknown }) =>
          event.type === 'agent-preset/selected' ? (event.data as { agentPreset: string }).agentPreset : state,
      },
    }

    expect(deriveSessionPreset(surface, { header, events })).toBe('switched')
    expect(deriveSessionPreset(surface, { header, events: [] })).toBe('from-header')
    expect(deriveSessionPreset(surface, { header: {}, events: [] })).toBeUndefined()
  })

  it('delegates to the legacy resolver surface when no projection exists (rc line)', () => {
    const surface = {
      resolveSessionPreset: (session: { header: { agentPreset?: string | null } }) => session.header.agentPreset,
    }

    expect(deriveSessionPreset(surface, { header, events: [] })).toBe('from-header')
  })

  it('yields undefined when the host carries neither surface', () => {
    expect(deriveSessionPreset({}, { header, events })).toBeUndefined()
  })

  it('the real host module resolves newest-selection-wins through whichever surface it carries', () => {
    // The rc module exports resolveSessionPreset; a 0.1.2 module would export
    // the projection instead — the probe hides which one answered.
    const real = agentPresetsHost as unknown as PresetDerivationSurface
    expect(deriveSessionPreset(real, { header, events })).toBe('switched')
    expect(deriveSessionPreset(real, { header, events: [] })).toBe('from-header')
  })
})
