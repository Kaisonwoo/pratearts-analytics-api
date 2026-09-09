import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const requiredFiles = [
  '.clasp.json.example',
  '.gitignore',
  'README.md',
  'config/script-properties.example.json',
  'docs/adr/ADR-001-decisoes-fundacao.md',
  'src/appsscript.json',
  'src/Main.gs',
  'src/config/Config.gs',
  'src/core/Logger.gs'
];

for (const relative of requiredFiles) {
  await readFile(path.join(root, relative), 'utf8');
}

const manifest = JSON.parse(await readFile(path.join(root, 'src/appsscript.json'), 'utf8'));
assert.equal(manifest.runtimeVersion, 'V8');
assert.equal(manifest.timeZone, 'America/Sao_Paulo');
assert.equal(manifest.exceptionLogging, 'STACKDRIVER');
assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'));

const forbiddenFiles = ['.clasp.json', '.clasprc.json', '.env'];
const rootFiles = await readdir(root);
for (const forbidden of forbiddenFiles) {
  assert.ok(!rootFiles.includes(forbidden), `${forbidden} não pode ser versionado`);
}

const scanTargets = [
  'src/Main.gs',
  'src/config/Config.gs',
  'src/core/Logger.gs',
  'src/clients/BlingClient.gs',
  'src/services/HealthService.gs',
  'src/jobs/DailySyncJob.gs',
  'src/api/WebApp.gs'
];
const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /(?:client_secret|refresh_token|access_token)\s*[:=]\s*['\"](?!BLING_(?:CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)['\"])[^'\"]{16,}['\"]/i,
  /AIza[0-9A-Za-z_-]{35}/
];

for (const relative of scanTargets) {
  const content = await readFile(path.join(root, relative), 'utf8');
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(content), `Possível segredo encontrado em ${relative}`);
  }
}

console.log('Projeto validado: estrutura, manifesto e verificação de segredos aprovados.');
