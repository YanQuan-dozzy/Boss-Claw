// Actual Electron <webview> IPC/input regressions. Windows only, fully offline.
// Install the locked runtime with node node_modules/electron/install.js after npm ci;
// a missing runtime is a failure, never a skip.
// BOSSCLAW_TEST_ELECTRON may point at an existing Electron/BossClaw runtime EXE.
// Only runtime root files/locales are copied; installed resources/app/userData are never used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(root, 'scripts/fixtures/webview-native-send');
assert.equal(process.platform, 'win32', 'native Electron regression requires Windows; run on the Windows CI runner');

function ast(source, name) {
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, `${name} must parse`);
  return parsed;
}

function extractPreload(source) {
  const parsed = ast(source, 'webview.cjs');
  const declarations = new Map();
  function inventory(statements) {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
        }
      }
      if (ts.isExpressionStatement(statement)) {
        let expression = statement.expression;
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        if (ts.isCallExpression(expression)) {
          let callee = expression.expression;
          while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
          if (ts.isFunctionExpression(callee) && callee.body) inventory(callee.body.statements);
        }
      }
    }
  }
  inventory(parsed.statements);
  const selected = new Map();
  const external = new Set(['ipcRenderer', 'humanize', 'notify']);
  function include(name) {
    if (external.has(name) || selected.has(name)) return;
    const declaration = declarations.get(name);
    assert.ok(declaration, `missing production declaration: ${name}`);
    selected.set(name, declaration);
    function dependencies(node) {
      if (ts.isIdentifier(node) && declarations.has(node.text) && node.text !== name) {
        const parent = node.parent;
        const isProperty = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent));
        const isDeclaration = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node;
        if (!isProperty && !isDeclaration) include(node.text);
      }
      ts.forEachChild(node, dependencies);
    }
    dependencies(declaration);
  }
  for (const name of ['trustedInput', 'trustedClickElement', 'trustedHoverElement', 'sendChatMessage', 'createChatSendContext', 'captureOwnMessages']) include(name);
  const code = [...selected.values()].sort((a, b) => a.pos - b.pos).map(node => {
    if (!ts.isVariableDeclaration(node)) return node.getText(parsed);
    const kind = node.parent.flags & ts.NodeFlags.Let ? 'let' : node.parent.flags & ts.NodeFlags.Const ? 'const' : 'var';
    return `${kind} ${node.getText(parsed)};`;
  }).join('\n');
  assert.ok(!/\brequire\s*\(/.test(code), 'extracted helpers must not initialize unrelated preload code');
  return { code, declarations: [...selected.keys()] };
}

async function electronPath() {
  if (process.env.BOSSCLAW_TEST_ELECTRON) return process.env.BOSSCLAW_TEST_ELECTRON;
  const packageDirectory = dirname(require.resolve('electron/package.json'));
  let binary;
  try { binary = (await readFile(join(packageDirectory, 'path.txt'), 'utf8')).trim(); }
  catch { throw new Error('Electron runtime missing: run node node_modules/electron/install.js after npm ci, or set BOSSCLAW_TEST_ELECTRON'); }
  return join(packageDirectory, 'dist', binary);
}

const executable = await electronPath();
await access(executable).catch(() => { throw new Error(`Electron runtime does not exist: ${executable}`); });
const runtimeSource = dirname(executable);
await mkdir(join(root, 'tmp'), { recursive: true });
const output = await mkdtemp(join(root, 'tmp/webview-native-send-'));
const runtime = join(output, 'runtime');
const generatedApp = join(runtime, 'resources/app');
await mkdir(generatedApp, { recursive: true });
for (const entry of await readdir(runtimeSource, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) continue;
  if (entry.isFile()) await copyFile(join(runtimeSource, entry.name), join(runtime, entry.name));
  if (entry.isDirectory() && entry.name === 'locales') await cp(join(runtimeSource, entry.name), join(runtime, entry.name), { recursive: true });
}
const stagedExecutable = join(runtime, 'electron-native-send-fixture.exe');
await copyFile(executable, stagedExecutable);
await chmod(stagedExecutable, 0o755);

const mainSource = await readFile(join(root, 'electron/main.cjs'), 'utf8');
const mainAst = ast(mainSource, 'main.cjs');
const handler = mainAst.statements.find(statement => ts.isExpressionStatement(statement)
  && statement.getText(mainAst).startsWith("ipcMain.on('jc:webview-input',"));
assert.ok(handler, 'real production jc:webview-input listener must exist');
const preloadSource = await readFile(join(root, 'electron/preload/webview.cjs'), 'utf8');
const extracted = extractPreload(preloadSource);
await writeFile(join(generatedApp, 'handler.cjs'), `module.exports = ({ ipcMain, BrowserWindow, dlog, inputWindows, inputWindowFor }) => {\n${handler.getText(mainAst)}\n};`);
await writeFile(join(generatedApp, 'production-helpers.cjs'), extracted.code);
await copyFile(join(root, 'electron/preload/humanize.cjs'), join(generatedApp, 'humanize.cjs'));
await copyFile(join(root, 'scripts/fixtures/webview-send/conversation.html'), join(generatedApp, 'guest.html'));
for (const name of ['main.cjs', 'host.html', 'preload.cjs', 'other.html']) await copyFile(join(fixture, name), join(generatedApp, name));
await writeFile(join(generatedApp, 'package.json'), JSON.stringify({ name: 'offline-native-send-regression', version: '1.0.0', main: 'main.cjs' }));
await writeFile(join(output, 'extraction.json'), JSON.stringify({ declarations: extracted.declarations,
  mainSha256: createHash('sha256').update(mainSource).digest('hex'), preloadSha256: createHash('sha256').update(preloadSource).digest('hex') }, null, 2));

console.log(`Actual offline Electron fixture: ${output}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_OVERRIDE_DIST_PATH;
const child = spawn(stagedExecutable, ['--enable-logging=stderr'], { cwd: runtime, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data.toString(); });
child.stderr.on('data', data => { stderr += data.toString(); });
const timer = setTimeout(() => child.kill(), 120_000);
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
await writeFile(join(output, 'stdout.txt'), stdout);
await writeFile(join(output, 'stderr.txt'), stderr);
let evidence;
try { evidence = JSON.parse(await readFile(join(output, 'results.json'), 'utf8')); }
catch { throw new Error(`Electron exited ${exitCode} without results; inspect ${output}/stderr.txt. ${stderr.slice(-1600)}`); }
assert.equal(exitCode, 0, `Electron failed: ${evidence.error || stderr.slice(-1600)}`);
assert.ok(!evidence.error, evidence.error);
const expectedCases = ['focused-zoom1', 'unfocused-zoom1', 'unfocused-guest125', 'host125-guest1', 'guest125', 'host125-guest125',
  'guest80', 'nested-svg125', 'scrolled-fixed125', 'guard-mutation125', 'click-without-bubble125',
  'center-overlay125', 'partly-clipped125', 'fully-covered125', 'overlay-moves-after-hover125'];
assert.deepEqual(evidence.expectedCases, expectedCases, 'fixture and assertions must agree on every scenario');
assert.deepEqual(evidence.results.map(result => result.name), expectedCases, 'all actual native scenarios must finish once in order');
assert.equal(evidence.nonLocalRequests.length, 0, 'fixture must not request network content');
for (const result of evidence.results) {
  assert.ok(!result.error, `${result.name}: ${result.error}`);
  assert.equal(result.typed.ok, true, `${result.name}: real insertText IPC reply`);
  const inputs = result.events.filter(event => event.type === 'input');
  assert.equal(inputs.length, 1, `${result.name}: exactly one native input`);
  assert.equal(inputs[0].trusted, true, `${result.name}: native input must be trusted`);
  const clicks = result.events.filter(event => event.type === 'click');
  const requests = evidence.requests.filter(request => request.name === result.name);
  if (!result.cfg.focus) assert.ok(requests.every(request => !request.windowFocused), `${result.name}: other window must actually own focus`);
  assert.equal(requests.filter(request => request.action === 'pressEnter').length, 0, `${result.name}: no Enter fallback/retry`);
  if (result.cfg.overlay || result.cfg.clipped) assert.equal(result.geometry.centerWithinSend, false, `${result.name}: center must actually fail hit-testing`);
  if (result.cfg.clipped) assert.equal(result.geometry.centerOutsideViewport, true, `${result.name}: original center must actually lie beyond the viewport`);
  if (result.cfg.overlay === 'moving') {
    assert.equal(result.geometry.changedOnNativeHover, true, `${result.name}: overlay must move during real hover`);
    assert.equal(result.geometry.initialPointNowCovered, true, `${result.name}: original safe point must become covered before final click`);
    assert.ok(clicks[0] && Math.abs(clicks[0].x - result.geometry.initialPoint.x) > 3, `${result.name}: final click must choose a fresh point`);
  }
  if (result.cfg.guardFailure || result.cfg.expectBlocked) {
    assert.equal(clicks.length, 0, `${result.name}: guard must prevent every click`);
    assert.equal(requests.filter(request => request.action === 'clickAt').length, 0, `${result.name}: no click IPC after guard failure`);
    assert.equal(result.result.clicked, false, `${result.name}: clicked must be false`);
    assert.equal(result.result.sent, null, `${result.name}: uncertain send is preserved`);
    assert.equal(result.ownMessages.length, 1, `${result.name}: no new bubble`);
    continue;
  }
  assert.equal(clicks.length, 1, `${result.name}: exactly one native click`);
  assert.equal(clicks[0].trusted, true, `${result.name}: click must be trusted`);
  assert.equal(clicks[0].withinSend, true, `${result.name}: click must hit send button or descendant`);
  assert.equal(requests.filter(request => request.action === 'clickAt').length, 1, `${result.name}: no second dispatch`);
  assert.equal(result.result.clicked, true, `${result.name}: actual target click confirmed`);
  if (result.cfg.noBubble) {
    assert.equal(result.result.ok, false, `${result.name}: native click is not delivery proof`);
    assert.equal(result.result.sent, null, `${result.name}: no bubble is uncertain`);
    assert.equal(result.input, result.text, `${result.name}: unchanged draft preserved`);
    assert.equal(result.ownMessages.length, 1, `${result.name}: no new bubble`);
  } else {
    assert.equal(result.result.ok, true, `${result.name}: ${result.result.reason}`);
    assert.equal(result.result.sent, true, `${result.name}: full new local bubble confirmed`);
    assert.equal(result.input, '', `${result.name}: draft cleared`);
    assert.deepEqual(result.ownMessages, ['历史消息', result.text], `${result.name}: exactly one full own bubble`);
    if (result.cfg.layout === 'fixed') assert.ok(result.viewport.scrollY > 400, `${result.name}: fixed-bar case must actually scroll`);
  }
}
console.log(`PASS ${evidence.results.length} actual Electron native send scenarios (Electron ${evidence.electron}; Chromium ${evidence.chromium}). Evidence: ${output}/results.json`);
