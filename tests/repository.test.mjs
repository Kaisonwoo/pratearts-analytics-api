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

test('exemplo de Script Properties documenta OAuth sem valores sensíveis', async () => {
  const example = JSON.parse(await readFile(path.join(root, 'config/script-properties.example.json'), 'utf8'));
  for (const key of ['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_ACCESS_TOKEN', 'BLING_REFRESH_TOKEN']) {
    assert.equal(example[key], '');
  }
  assert.equal(example.BLING_REDIRECT_URI, '');
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

test('segredos possuem acesso centralizado e gravação protegida por lock', async () => {
  const config = await readFile(path.join(root, 'src/config/Config.gs'), 'utf8');
  const secrets = await readFile(path.join(root, 'src/config/Secrets.gs'), 'utf8');

  assert.doesNotMatch(config, /\bget:\s*get\b/);
  assert.doesNotMatch(config, /\brequireValue:\s*requireValue\b/);
  assert.match(secrets, /LockService\.getScriptLock\(\)/);
  assert.match(secrets, /setProperties\(values, false\)/);
  assert.match(secrets, /token_type não suportado/);
});

test('diagnóstico público não expõe credenciais ou tokens', async () => {
  const values = new Map([
    ['BLING_CLIENT_ID', 'client-id-de-teste'],
    ['BLING_CLIENT_SECRET', 'client-secret-de-teste'],
    ['BLING_REDIRECT_URI', 'https://script.google.com/macros/s/teste/exec']
  ]);
  const lockEvents = [];
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({
        waitLock: (milliseconds) => lockEvents.push(['wait', milliseconds]),
        releaseLock: () => lockEvents.push(['release'])
      })
    },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  for (const relative of ['src/config/Config.gs', 'src/config/Secrets.gs']) {
    const content = await readFile(path.join(root, relative), 'utf8');
    vm.runInContext(content, context, { filename: relative });
  }

  const status = vm.runInContext(`PRASecrets.saveTokenResponse({
    access_token: 'access-token-de-teste',
    refresh_token: 'refresh-token-de-teste',
    expires_in: 3600,
    token_type: 'Bearer'
  })`, context);
  const publicSnapshot = vm.runInContext('PRAConfig.getPublicSnapshot()', context);
  const serializedPublicSnapshot = JSON.stringify(publicSnapshot);

  assert.equal(status.accessTokenPresent, true);
  assert.equal(status.refreshTokenPresent, true);
  assert.equal(status.expired, false);
  assert.deepEqual(lockEvents, [['wait', 30000], ['release']]);
  assert.doesNotMatch(serializedPublicSnapshot, /client-secret-de-teste/);
  assert.doesNotMatch(serializedPublicSnapshot, /access-token-de-teste/);
  assert.doesNotMatch(serializedPublicSnapshot, /refresh-token-de-teste/);
  assert.equal(publicSnapshot.validation.valid, true);
});
