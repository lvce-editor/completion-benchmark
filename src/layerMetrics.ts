import type { CDPSession } from 'playwright'

export interface CompositedLayer {
  readonly layerId: string
  readonly drawsContent: boolean
  readonly width: number
  readonly height: number
}

export interface LayerTreeEvidence {
  readonly observedAt: string
  readonly layers: readonly CompositedLayer[]
  readonly compositedLayerCount: number
  readonly contentLayerCount: number
}

export class LayerTreeCollector {
  private readonly session: CDPSession
  private layers: readonly CompositedLayer[] | undefined
  private readonly listener: (event: { layers?: readonly CompositedLayer[] }) => void

  constructor(session: CDPSession) {
    this.session = session
    this.listener = ({ layers }) => {
      if (layers) this.layers = layers
    }
    session.on('LayerTree.layerTreeDidChange', this.listener)
  }

  async start(): Promise<void> {
    await this.session.send('LayerTree.enable')
  }

  captureAtEndpoint(): LayerTreeEvidence {
    if (!this.layers) throw new Error('Chromium did not provide LayerTree.layerTreeDidChange evidence')
    if (this.layers.some((layer) => typeof layer.layerId !== 'string' || typeof layer.drawsContent !== 'boolean' || !Number.isFinite(layer.width) || layer.width < 0 || !Number.isFinite(layer.height) || layer.height < 0)) {
      throw new Error('Chromium provided an invalid composited layer tree')
    }
    return {
      observedAt: new Date().toISOString(),
      layers: this.layers,
      compositedLayerCount: this.layers.length,
      contentLayerCount: this.layers.filter((layer) => layer.drawsContent).length,
    }
  }

  async stop(): Promise<void> {
    this.session.off('LayerTree.layerTreeDidChange', this.listener)
    await this.session.send('LayerTree.disable').catch(() => {})
  }
}
