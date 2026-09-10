import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const requiredFiles = [
  '.clasp.json.example',
  '.gitignore',
  'README.md',
  'config/bling-read-model.json',
  'config/script-properties.example.json',
  'docs/adr/ADR-001-decisoes-fundacao.md',
  'docs/bling-api-mapping.md',
  'docs/connectivity-health.md',
  'docs/http-client.md',
  'docs/oauth-authorization.md',
  'docs/pagination-resilience.md',
  'docs/token-renewal.md',
  'docs/samples/bling/product-detail-with-variations.json',
  'docs/samples/bling/product-list.json',
  'docs/samples/bling/product-supplier-list.json',
  'docs/samples/bling/sales-order-detail.json',
  'docs/samples/bling/sales-order-list.json',
  'docs/samples/bling/situations.json',
  'docs/samples/bling/stock-balance.json',
  'src/appsscript.json',
  'src/Main.gs',
  'src/api/WebApp.gs',
  'src/config/Config.gs',
  'src/config/Secrets.gs',
  'src/clients/BlingClient.gs',
  'src/core/Resilience.gs',
  'src/core/Logger.gs',
  'src/services/HealthService.gs',
  'src/services/OAuthService.gs'
];

for (const relative of requiredFiles) {
  await readFile(path.join(root, relative), 'utf8');
}

const manifest = JSON.parse(await readFile(path.join(root, 'src/appsscript.json'), 'utf8'));
assert.equal(manifest.runtimeVersion, 'V8');
assert.equal(manifest.timeZone, 'America/Sao_Paulo');
assert.equal(manifest.exceptionLogging, 'STACKDRIVER');
assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'));
assert.ok(manifest.urlFetchWhitelist.includes('https://bling.com.br/'));

const readModel = JSON.parse(await readFile(path.join(root, 'config/bling-read-model.json'), 'utf8'));
assert.equal(readModel.source.apiVersion, '3.0');
assert.equal(readModel.defaults.readOnly, true);
assert.ok(readModel.resources.every((resource) => resource.method === 'GET'));

const forbiddenFiles = ['.clasp.json', '.clasprc.json', '.env'];
const rootFiles = await readdir(root);
for (const forbidden of forbiddenFiles) {
  assert.ok(!rootFiles.includes(forbidden), `${forbidden} não pode ser versionado`);
}

async function listGsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listGsFiles(target) : [target];
  }));
  return nested.flat().filter((file) => file.endsWith('.gs'));
}

const scanTargets = await listGsFiles(path.join(root, 'src'));
const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /(?:client_secret|refresh_token|access_token)\s*[:=]\s*['\"](?!BLING_(?:CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)['\"])[^'\"]{16,}['\"]/i,
  /AIza[0-9A-Za-z_-]{35}/
];

for (const target of scanTargets) {
  const content = await readFile(target, 'utf8');
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(content), `Possível segredo encontrado em ${path.relative(root, target)}`);
  }
}

console.log('Projeto validado: estrutura, manifesto e verificação de segredos aprovados.');
