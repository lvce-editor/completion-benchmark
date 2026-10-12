import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { CDPSession } from 'playwright'
import { LayerTreeCollector } from '../src/layerMetrics.ts'

test('captures the latest observed layer tree and counts all and content layers', async () => {
  const session = new EventEmitter() as EventEmitter & { send: (method: string) => Promise<void> }
  const commands: string[] = []
  session.send = async (method) => {
    commands.push(method)
    if (method === 'LayerTree.enable') session.emit('LayerTree.layerTreeDidChange', { layers: [
      { layerId: 'root', drawsContent: false, width: 1280, height: 900 },
      { layerId: 'editor', drawsContent: true, width: 1000, height: 700 },
      { layerId: 'overlay', drawsContent: true, width: 300, height: 200 },
    ] })
  }
  const collector = new LayerTreeCollector(session as unknown as CDPSession)
  await collector.start()
  const evidence = collector.captureAtEndpoint()
  assert.equal(evidence.compositedLayerCount, 3)
  assert.equal(evidence.contentLayerCount, 2)
  assert.equal(evidence.layers.length, 3)
  assert.equal(Number.isFinite(Date.parse(evidence.observedAt)), true)
  await collector.stop()
  assert.deepEqual(commands, ['LayerTree.enable', 'LayerTree.disable'])
  assert.equal(session.listenerCount('LayerTree.layerTreeDidChange'), 0)
})

test('reports unavailable layer-tree observations rather than inventing zero', async () => {
  const session = new EventEmitter() as EventEmitter & { send: (method: string) => Promise<void> }
  session.send = async () => {}
  const collector = new LayerTreeCollector(session as unknown as CDPSession)
  await collector.start()
  assert.throws(() => collector.captureAtEndpoint(), /did not provide LayerTree/)
  await collector.stop()
})
