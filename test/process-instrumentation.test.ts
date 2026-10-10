import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { processInstrumentation, utilityBootstrap, parseInspectorProcesses } from '../src/process-instrumentation.ts'

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


test('utility bootstrap preserves entry argv and installs descendant instrumentation before entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-utility-bootstrap-'))
  try {
    const entry = join(root, 'entry.cjs')
    const preload = join(root, 'process-instrumentation.cjs')
    const bootstrap = join(root, 'utility-bootstrap.cjs')
    await writeFile(preload, processInstrumentation)
    await writeFile(bootstrap, utilityBootstrap)
    await writeFile(entry, `if(process.argv[1]!==${JSON.stringify(entry)} || process.argv[2]!=='argument') process.exit(2); process.exit(0);`)
    const result = spawnSync(process.execPath, [bootstrap, 'argument'], { env: { ...process.env, COMPLETION_BENCHMARK_ENTRY: entry }, timeout: 15000 })
    assert.equal(result.status, 0, result.stderr.toString())
    const records = parseInspectorProcesses(await readFile(join(root, 'process-inspectors.jsonl'), 'utf8'))
    assert.equal(records.length, 1)
    assert.ok(records[0].argv.includes(entry))
    assert.ok(!records[0].argv.includes(bootstrap))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Atom renderer spawn hook captures Node-mode children and their grandchildren', async () => {
  const { atomRendererInstrumentation } = await import('../src/process-instrumentation.ts')
  const root = await mkdtemp(join(tmpdir(), 'completion-atom-spawn-'))
  try {
    await writeFile(join(root, 'process-instrumentation.cjs'), processInstrumentation)
    const hook = join(root, 'renderer.cjs')
    await writeFile(hook, atomRendererInstrumentation)
    const grandchild = join(root, 'grandchild.cjs')
    const child = join(root, 'child.cjs')
    const parent = join(root, 'parent.cjs')
    await writeFile(grandchild, 'process.exit(0)')
    await writeFile(child, `require('child_process').fork(${JSON.stringify(grandchild)},[],{execArgv:[]}).on('exit',code=>process.exit(code))`)
    await writeFile(parent, `require(${JSON.stringify(hook)});require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}).on('exit',code=>process.exit(code))`)
    const result = spawnSync(process.execPath, [parent], { timeout: 15000 })
    assert.equal(result.status, 0, result.stderr.toString())
    const records = parseInspectorProcesses(await readFile(join(root, 'process-inspectors.jsonl'), 'utf8'))
    assert.equal(records.length, 2)
    assert.ok(records.some((record) => record.argv.includes(child)))
    assert.ok(records.some((record) => record.argv.includes(grandchild)))
    assert.ok(!records.some((record) => record.argv.includes(parent)))
  } finally { await rm(root, { recursive: true, force: true }) }
})
