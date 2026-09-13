import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildRuntime } from '../scripts/build-apps-script.mjs';

test('runtime consolidado carrega todos os módulos e entradas operacionais', async () => {
  const built = await buildRuntime(process.cwd(), 'synthetic-revision');
  const context = vm.createContext({});
  vm.runInContext(built.code, context);
  for (const name of ['PRAMartsJob', 'PRAOrdersAnalyticsPipeline', 'PRAKpiService', 'PRAMartService']) {
    assert.equal(typeof context[name], 'object', name);
  }
  for (const name of ['runDailySync', 'runMartsBuild', 'runMartsContinuation', 'provisionDataLayers']) {
    assert.equal(typeof context[name], 'function', name);
  }
  for (const file of built.files) assert.equal(built.code.split(`// BEGIN ${file}\n`).length, 2);
  assert.equal((await buildRuntime(process.cwd(), 'synthetic-revision')).sourceHash, built.sourceHash);
});

test('runtime inclui automaticamente novo módulo e invalida hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pra-runtime-'));
  try {
    await mkdir(path.join(root, 'src/services'), { recursive: true });
    await writeFile(path.join(root, 'src/appsscript.json'), '{}');
    await writeFile(path.join(root, 'src/Main.gs'), 'function entry() {}');
    const before = await buildRuntime(root);
    await writeFile(path.join(root, 'src/services/NewService.gs'), 'var newService = {};');
    const after = await buildRuntime(root);
    assert.equal(after.files.length, 2);
    assert.notEqual(before.sourceHash, after.sourceHash);
    assert.match(after.code, /var newService/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
