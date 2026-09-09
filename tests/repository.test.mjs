import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

async function listGsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listGsFiles(target) : [target];
  }));
  return nested.flat().filter((file) => file.endsWith('.gs'));
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
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

test('matriz do Bling cobre os contratos obrigatórios usando somente leitura', async () => {
  const model = await readJson('config/bling-read-model.json');
  const resources = new Map(model.resources.map((resource) => [resource.key, resource]));
  const expected = new Map([
    ['salesOrders', '/pedidos/vendas'],
    ['salesOrderDetail', '/pedidos/vendas/{idPedidoVenda}'],
    ['products', '/produtos'],
    ['productDetail', '/produtos/{idProduto}'],
    ['productVariations', '/produtos/variacoes/{idProdutoPai}'],
    ['productSuppliers', '/produtos/fornecedores'],
    ['stockBalances', '/estoques/saldos'],
    ['situationModules', '/situacoes/modulos'],
    ['moduleSituations', '/situacoes/modulos/{idModuloSistema}']
  ]);

  assert.equal(model.source.apiVersion, '3.0');
  assert.equal(model.defaults.responseEnvelope, 'data');
  assert.equal(model.defaults.readOnly, true);
  assert.equal(model.businessRules.validSaleSituation, 'Atendido');

  for (const [key, endpoint] of expected) {
    assert.ok(resources.has(key), `Recurso obrigatório ausente: ${key}`);
    assert.equal(resources.get(key).path, endpoint);
  }

  for (const resource of model.resources) {
    assert.equal(resource.method, 'GET', `${resource.key} deve permanecer somente leitura`);
  }

  assert.ok(resources.get('salesOrders').filters.includes('dataAlteracaoInicial'));
  assert.ok(resources.get('salesOrders').filters.includes('idsSituacoes[]'));
  assert.ok(resources.get('salesOrderDetail').itemFields.includes('itens[].produto.id'));
  assert.ok(resources.get('products').keyFields.includes('idProdutoPai'));
  assert.ok(resources.get('products').keyFields.includes('codigo'));
  assert.ok(resources.get('productSuppliers').keyFields.includes('fornecedor.id'));
});

test('payloads sintéticos preservam IDs, SKU, pai/filho e fornecedor', async () => {
  const orderList = await readJson('docs/samples/bling/sales-order-list.json');
  const orderDetail = await readJson('docs/samples/bling/sales-order-detail.json');
  const productList = await readJson('docs/samples/bling/product-list.json');
  const productDetail = await readJson('docs/samples/bling/product-detail-with-variations.json');
  const supplierLinks = await readJson('docs/samples/bling/product-supplier-list.json');
  const stock = await readJson('docs/samples/bling/stock-balance.json');
  const situations = await readJson('docs/samples/bling/situations.json');

  const parent = productList.data.find((product) => product.idProdutoPai === 0);
  const child = productList.data.find((product) => product.idProdutoPai === parent.id);
  const item = orderDetail.data.itens[0];
  const supplierLink = supplierLinks.data[0];
  const balance = stock.data[0];

  assert.equal(orderList.data[0].id, orderDetail.data.id);
  assert.equal(orderList.data[0].situacao.id, situations.situations.data[0].id);
  assert.equal(situations.situations.data[0].nome, 'Atendido');
  assert.equal(item.produto.id, child.id);
  assert.equal(item.codigo, child.codigo);
  assert.equal(productDetail.data.id, parent.id);
  assert.equal(productDetail.data.variacoes[0].id, child.id);
  assert.equal(productDetail.data.variacoes[0].variacao.produtoPai.id, parent.id);
  assert.equal(supplierLink.produto.id, child.id);
  assert.equal(supplierLink.padrao, true);
  assert.equal(balance.produto.id, child.id);
  assert.equal(balance.produto.codigo, child.codigo);
});

test('payloads de contrato não contêm padrões comuns de dados sensíveis', async () => {
  const samples = [
    'product-detail-with-variations.json',
    'product-list.json',
    'product-supplier-list.json',
    'sales-order-detail.json',
    'sales-order-list.json',
    'situations.json',
    'stock-balance.json'
  ];
  const forbiddenPatterns = [
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/,
    /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
    /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/,
    /\b\d{11}\b/,
    /\b\d{14}\b/,
    /Bearer\s+[A-Za-z0-9._-]{20,}/,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
  ];

  for (const sample of samples) {
    const content = await readFile(path.join(root, 'docs/samples/bling', sample), 'utf8');
    const payload = JSON.parse(content);
    assert.ok('data' in payload || ('modules' in payload && 'situations' in payload));
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `Possível dado sensível encontrado em ${sample}`);
    }
  }
});

test('OAuth cria state temporário, troca o código por JWT e bloqueia replay', async () => {
  const values = new Map([
    ['BLING_CLIENT_ID', 'client-id-publico-de-teste'],
    ['BLING_CLIENT_SECRET', 'client-secret-privado-de-teste'],
    ['BLING_REDIRECT_URI', 'https://script.google.com/macros/s/deployment-teste/exec']
  ]);
  const fetchCalls = [];
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  let uuidSequence = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value, 'utf8').digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      base64Encode: (value) => Buffer.from(value, 'utf8').toString('base64')
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            access_token: 'jwt-access-token-sintetico',
            refresh_token: 'jwt-refresh-token-sintetico',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        };
      }
    },
    PRALogger: { warn: () => {}, error: () => {} },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    encodeURIComponent
  });

  for (const relative of [
    'src/config/Config.gs',
    'src/config/Secrets.gs',
    'src/services/OAuthService.gs'
  ]) {
    vm.runInContext(await readFile(path.join(root, relative), 'utf8'), context, { filename: relative });
  }

  const request = vm.runInContext('PRAOAuthService.createAuthorizationRequest()', context);
  const authorizationUrl = new URL(request.authorizationUrl);
  const state = authorizationUrl.searchParams.get('state');

  assert.equal(authorizationUrl.origin, 'https://bling.com.br');
  assert.equal(authorizationUrl.pathname, '/Api/v3/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'client-id-publico-de-teste');
  assert.ok(state.length >= 64);
  assert.notEqual(values.get('BLING_OAUTH_STATE_HASH'), state);
  assert.ok(Number(values.get('BLING_OAUTH_STATE_EXPIRES_AT')) > Date.now());
  assert.doesNotMatch(request.authorizationUrl, /client-secret-privado-de-teste/);

  context.callbackInput = { state, code: 'authorization-code-sintetico' };
  const result = vm.runInContext('PRAOAuthService.handleCallback(callbackInput)', context);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'authorized');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://bling.com.br/Api/v3/oauth/token');
  assert.equal(fetchCalls[0].options.method, 'post');
  assert.equal(fetchCalls[0].options.contentType, 'application/x-www-form-urlencoded');
  assert.equal(fetchCalls[0].options.headers['enable-jwt'], '1');
  assert.equal(fetchCalls[0].options.payload.grant_type, 'authorization_code');
  assert.equal(fetchCalls[0].options.payload.code, 'authorization-code-sintetico');
  assert.equal(
    fetchCalls[0].options.headers.Authorization,
    `Basic ${Buffer.from('client-id-publico-de-teste:client-secret-privado-de-teste').toString('base64')}`
  );
  assert.equal(values.get('BLING_ACCESS_TOKEN'), 'jwt-access-token-sintetico');
  assert.equal(values.get('BLING_REFRESH_TOKEN'), 'jwt-refresh-token-sintetico');
  assert.equal(values.has('BLING_OAUTH_STATE_HASH'), false);
  assert.doesNotMatch(JSON.stringify(result), /jwt-(?:access|refresh)-token-sintetico/);

  const replay = vm.runInContext('PRAOAuthService.handleCallback(callbackInput)', context);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_state');
  assert.equal(fetchCalls.length, 1);
});

test('OAuth trata recusa sem chamar o endpoint de token', async () => {
  const oauthSource = await readFile(path.join(root, 'src/services/OAuthService.gs'), 'utf8');
  const webAppSource = await readFile(path.join(root, 'src/api/WebApp.gs'), 'utf8');

  assert.match(oauthSource, /authorization_denied/);
  assert.match(oauthSource, /Nenhum token foi armazenado/);
  assert.match(oauthSource, /consumeOAuthState/);
  assert.match(webAppSource, /parameters\.action === 'authorize'/);
  assert.match(webAppSource, /renderAuthorizationCallback_/);
  assert.doesNotMatch(webAppSource, /BLING_CLIENT_SECRET|BLING_ACCESS_TOKEN|BLING_REFRESH_TOKEN/);
});
