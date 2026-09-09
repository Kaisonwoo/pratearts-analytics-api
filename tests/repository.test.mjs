import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

async function listGsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listGsFiles(target) : [target];
  }));
  return nested.flat().filter((file) => file.endsWith('.gs'));
}

test('manifesto usa V8, logging e fuso aprovados', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'src/appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.exceptionLogging, 'STACKDRIVER');
  assert.equal(manifest.timeZone, 'America/Sao_Paulo');
});

test('exemplo de Script Properties não contém valores sensíveis', async () => {
  const example = JSON.parse(await readFile(path.join(root, 'config/script-properties.example.json'), 'utf8'));
  for (const key of ['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_ACCESS_TOKEN', 'BLING_REFRESH_TOKEN']) {
    assert.equal(example[key], '');
  }
});

test('.gitignore protege credenciais e configuração local', async () => {
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
  for (const entry of ['.clasp.json', '.clasprc.json', '.env']) {
    assert.match(ignore, new RegExp(`^${entry.replace('.', '\\\.')}\\r?$`, 'm'));
  }
});

test('todos os arquivos Apps Script possuem sintaxe JavaScript válida', async () => {
  const files = await listGsFiles(path.join(root, 'src'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.doesNotThrow(() => new vm.Script(content, { filename: file }));
  }
});
