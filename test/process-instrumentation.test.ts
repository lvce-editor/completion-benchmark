import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { processInstrumentation, parseInspectorProcesses } from '../src/process-instrumentation.ts'

test('preload instruments grandchildren even when fork overrides execArgv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-process-coverage-'))
  try {
    const preload = join(root, 'instrument.cjs')
    const child = join(root, 'child.cjs')
    const parent = join(root, 'parent.cjs')
    await writeFile(preload, processInstrumentation)
    await writeFile(child, `process.send({pid:process.pid}); process.exit(0);`)
    await writeFile(parent, `const child=require('node:child_process').fork(${JSON.stringify(child)},[],{execArgv:[]}); child.on('exit',code=>process.exit(code));`)
    const result = spawnSync(process.execPath, ['--require', preload, parent], { timeout: 15000 })
    assert.equal(result.status, 0, result.stderr.toString())
    const records = parseInspectorProcesses(await readFile(join(root, 'process-inspectors.jsonl'), 'utf8'))
    assert.equal(records.length, 2)
    const server = records.find((record) => record.argv.includes(child))!
    assert.ok(server)
    assert.equal(server.parentPid, records.find((record) => record.argv.includes(parent))!.pid)
    assert.notEqual(server.url, records.find((record) => record.argv.includes(parent))!.url)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects malformed backend inspector records', () => {
  assert.throws(() => parseInspectorProcesses('{"pid":0,"argv":[],"url":""}'), /Malformed/)
  assert.throws(() => parseInspectorProcesses('incomplete'), SyntaxError)
})
