// Exercise the shipped stdio entry point without calling the e-Gov API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const remote = process.argv.includes('--registry');
const child = spawn(remote ? 'npx' : process.execPath, remote
  ? ['--yes', `--package=${pkg.name}@${pkg.version}`, 'egov-law-mcp']
  : ['bin/egov-law-mcp.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
try {
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.on('error', () => {}); // Report premature exit below.
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'release-smoke', version: '1.0.0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(await closed, 0, `MCP did not exit successfully: ${stderr}`);
  const replies = stdout.trim().split('\n').map(JSON.parse).flat();
  assert.equal(replies.find(r => r.id === 1)?.result?.serverInfo?.version, pkg.version);
  const tools = replies.find(r => r.id === 2)?.result?.tools;
  assert.deepEqual(tools?.map(t => t.name).sort(),
    ['find_related_laws', 'get_article', 'get_law', 'search_laws']);
  for (const tool of tools) assert.ok(tool.inputSchema.properties.asof, `${tool.name}: missing asof`);
  console.log(`${remote ? 'npm Registry' : 'local'} MCP ${pkg.version}: initialize + four asof tools OK`);
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill();
}
