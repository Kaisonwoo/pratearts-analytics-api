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
  for (const name of ['PRAMartsJob', 'PRAOrdersAnalyticsPipeline', 'PRAKpiService', 'PRAMartService', 'PRAReportService', 'PRADailyTriggerScheduler']) {
    assert.equal(typeof context[name], 'object', name);
  }
  for (const name of ['runDailySync', 'installDailySyncTrigger', 'getDailySyncTriggerStatus', 'removeDailySyncTrigger', 'runMartsBuild', 'runMartsContinuation', 'provisionDataLayers', 'getDashboardSnapshot']) {
    assert.equal(typeof context[name], 'function', name);
  }
  for (const file of built.files) assert.equal(built.code.split(`// BEGIN ${file}\n`).length, 2);
  assert.equal((await buildRuntime(process.cwd(), 'synthetic-revision')).sourceHash, built.sourceHash);
  assert.equal(context.PRA_RUNTIME_METADATA.revision, 'synthetic-revision');
  assert.equal(context.PRA_RUNTIME_METADATA.sourceHash, built.sourceHash);
  assert.deepEqual(built.htmlFiles.map(file => file.name), ['Index.html']);
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


test('runtime inclui HTML no hash e preserva nome para o Apps Script', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pra-runtime-html-'));
  try {
    await mkdir(path.join(root, 'src/ui'), { recursive: true });
    await writeFile(path.join(root, 'src/appsscript.json'), '{}');
    await writeFile(path.join(root, 'src/Main.gs'), 'function entry() {}');
    await writeFile(path.join(root, 'src/ui/Index.html'), '<!doctype html><title>A</title>');
    const before = await buildRuntime(root);
    assert.deepEqual(before.htmlFiles.map(file => file.name), ['Index.html']);
    await writeFile(path.join(root, 'src/ui/Index.html'), '<!doctype html><title>B</title>');
    const after = await buildRuntime(root);
    assert.notEqual(after.sourceHash, before.sourceHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});
