// Written into the isolated profile as a CommonJS preload so every instrumented
// Node child installs the same fork hook before its application entrypoint runs.
export const processInstrumentation = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const childProcess = require('node:child_process');
if (!inspector.url()) inspector.open(0, '127.0.0.1');
const record = { pid: process.pid, parentPid: process.ppid, argv: process.argv, role: process.type || 'node', url: inspector.url() };
fs.appendFileSync(path.join(path.dirname(__filename), 'process-inspectors.jsonl'), JSON.stringify(record) + '\n');
const instrument = (original) => function(file, args, options = {}) {
  if (!Array.isArray(args)) { options = args || {}; args = undefined; }
  const execArgv = (options.execArgv || process.execArgv).filter(arg => !arg.startsWith('--inspect') && arg !== '--require=' + __filename);
  execArgv.push('--inspect=0', '--require=' + __filename);
  return original.call(this, file, args, { ...options, execArgv });
};
childProcess.fork = instrument(childProcess.fork);
if (process.type === 'browser') {
  const electron = require('electron');
  if (typeof electron.utilityProcess?.fork !== 'function') throw new Error('Electron utilityProcess.fork is unavailable');
  electron.utilityProcess.fork = instrument(electron.utilityProcess.fork);
}
`

export interface InspectorProcess { pid: number; parentPid: number; argv: string[]; role: string; url: string }

export function parseInspectorProcesses(text: string): InspectorProcess[] {
  const records = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as InspectorProcess)
  if (records.some((record) => !Number.isSafeInteger(record.pid) || record.pid < 1 || !record.url?.startsWith('ws://') || !Array.isArray(record.argv))) throw new Error('Malformed backend inspector inventory')
  return [...new Map(records.map((record) => [record.pid, record])).values()]
}
