import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync } from 'node:zlib'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { cpus, totalmem, release } from 'node:os'

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned desktop editor downloads currently support Linux x64 only')
const versions = JSON.parse(await readFile('config/versions.json', 'utf8'))
const apps = resolve('.tmp/apps')
const fixture = resolve('.tmp/fixture')
await mkdir(apps, { recursive: true })

async function download(url: string, file: string, digest: string): Promise<void> {
  if (!existsSync(file)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { 'user-agent': 'lvce-editor-completion-benchmark' } })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
    await writeFile(file, Buffer.from(await response.arrayBuffer()))
  }
  const actual = createHash('sha256').update(await readFile(file)).digest('hex')
  if (actual !== digest) throw new Error(`SHA-256 mismatch for ${file}: expected ${digest}, got ${actual}`)
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal ?? result.error})`)
}

const lvce = versions.lvce
const lvceArchive = join(apps, lvce.asset)
const lvceRoot = join(apps, 'lvce')
await download(lvce.url, lvceArchive, lvce.sha256)
await rm(lvceRoot, { recursive: true, force: true })
await mkdir(lvceRoot, { recursive: true })
run('dpkg-deb', ['-x', lvceArchive, lvceRoot])
const lvceBinary = join(lvceRoot, lvce.binary)

const ts = lvce.typescriptExtension
const tsArchive = join(apps, ts.asset)
const tsRoot = join(apps, 'typescript-extension')
await download(ts.url, tsArchive, ts.sha256)
await rm(tsRoot, { recursive: true, force: true })
await mkdir(tsRoot, { recursive: true })
// The release is Brotli compressed; extract the verified uncompressed tar through stdin.
const tar = spawnSync('tar', ['-xf', '-', '-C', tsRoot], { input: brotliDecompressSync(await readFile(tsArchive)), stdio: ['pipe', 'inherit', 'inherit'] })
if (tar.status !== 0) throw new Error(`Could not unpack TypeScript extension (${tar.status ?? tar.signal})`)
const tsManifest = JSON.parse(await readFile(join(tsRoot, 'extension.json'), 'utf8'))
if (tsManifest.id !== 'builtin.language-features-typescript' || tsManifest.version !== ts.version.slice(1)) {
  throw new Error(`Unexpected TypeScript provider ${tsManifest.id}@${tsManifest.version}`)
}

const vscode = versions.vscode
const vscodeArchive = join(apps, vscode.asset)
const vscodeRoot = join(apps, 'vscode')
await download(vscode.url, vscodeArchive, vscode.sha256)
await rm(vscodeRoot, { recursive: true, force: true })
await mkdir(vscodeRoot, { recursive: true })
run('tar', ['-xzf', vscodeArchive, '-C', vscodeRoot])
const vscodeManifest = JSON.parse(await readFile(join(vscodeRoot, vscode.binary.replace('/code', '/resources/app/package.json')), 'utf8'))
if (vscodeManifest.version !== vscode.version) throw new Error(`Unexpected VS Code version ${vscodeManifest.version}`)
const vscodeExtensions = join(vscodeRoot, 'VSCode-linux-x64/resources/app/extensions')
const vscodeHtml = JSON.parse(await readFile(join(vscodeExtensions, 'html-language-features/package.json'), 'utf8'))
const vscodeTs = JSON.parse(await readFile(join(vscodeExtensions, 'typescript-language-features/package.json'), 'utf8'))

await rm(fixture, { recursive: true, force: true })
await mkdir(join(fixture, 'html'), { recursive: true })
await mkdir(join(fixture, 'typescript'), { recursive: true })
const fixtureContents = {
  html: await readFile('fixtures/html/index.html'),
  typescript: await readFile('fixtures/typescript/index.ts'),
}
await writeFile(join(fixture, 'html/index.html'), fixtureContents.html)
await writeFile(join(fixture, 'typescript/index.ts'), fixtureContents.typescript)
const metadata = {
  platform: process.platform, architecture: process.arch, node: process.version,
  host: { cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryBytes: totalmem(), kernel: release() },
  run: { timestamp: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, id: process.env.GITHUB_RUN_ID ?? null },
  measurement: { viewport: { width: 1280, height: 900 }, gpu: false, warmup: 1, endpoint: 'query-qualified DOM through two animation frames', filtering: 'live open-list update including provider work', vscodeQuickSuggestions: false },
  lvce: { version: lvce.version, binary: lvceBinary, sha256: lvce.sha256, htmlProvider: 'bundled with LVCE release', typescriptProvider: tsManifest.version, typescriptProviderSha256: ts.sha256, completionsOnType: true },
  vscode: { version: vscodeManifest.version, binary: join(vscodeRoot, vscode.binary), sha256: vscode.sha256, htmlProvider: vscodeHtml.version, typescriptProvider: vscodeTs.version },
  fixtures: {
    html: 'html/index.html', typescript: 'typescript/index.ts', revision: 2,
    sha256: {
      html: createHash('sha256').update(fixtureContents.html).digest('hex'),
      typescript: createHash('sha256').update(fixtureContents.typescript).digest('hex'),
    },
  },
}
await writeFile('.tmp/setup.json', `${JSON.stringify(metadata, null, 2)}\n`)
console.log(`Verified LVCE ${metadata.lvce.version}, VS Code ${metadata.vscode.version}, and pinned provider versions`)
