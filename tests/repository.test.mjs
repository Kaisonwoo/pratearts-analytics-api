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

test('renovação usa lock, substitui o refresh token e evita POST duplicado', async () => {
  const values = new Map([
    ['BLING_CLIENT_ID', 'client-id-renovacao-teste'],
    ['BLING_CLIENT_SECRET', 'client-secret-renovacao-teste'],
    ['BLING_REDIRECT_URI', 'https://script.google.com/macros/s/deployment-teste/exec'],
    ['BLING_ACCESS_TOKEN', 'access-token-expirado-teste'],
    ['BLING_REFRESH_TOKEN', 'refresh-token-anterior-teste'],
    ['BLING_TOKEN_EXPIRES_AT', String(Date.now() - 1000)]
  ]);
  const fetchCalls = [];
  const lockEvents = [];
  const setPropertiesCalls = [];
  const logEntries = [];
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => {
      setPropertiesCalls.push({ ...items });
      Object.entries(items).forEach(([key, value]) => values.set(key, value));
    },
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
    Utilities: {
      base64Encode: (value) => Buffer.from(value, 'utf8').toString('base64')
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            access_token: 'access-token-renovado-teste',
            refresh_token: 'refresh-token-renovado-teste',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        };
      }
    },
    console: { log: (entry) => logEntries.push(JSON.parse(entry)) },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON
  });

  for (const relative of [
    'src/config/Config.gs',
    'src/core/Logger.gs',
    'src/config/Secrets.gs',
    'src/services/OAuthService.gs'
  ]) {
    vm.runInContext(await readFile(path.join(root, relative), 'utf8'), context, { filename: relative });
  }

  const first = vm.runInContext('PRAOAuthService.refreshAccessToken(60)', context);
  const second = vm.runInContext('PRAOAuthService.refreshAccessToken(60)', context);

  assert.equal(first.ok, true);
  assert.equal(first.refreshed, true);
  assert.equal(first.code, 'token_refreshed');
  assert.equal(second.ok, true);
  assert.equal(second.refreshed, false);
  assert.equal(second.code, 'token_still_valid');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://bling.com.br/Api/v3/oauth/token');
  assert.equal(fetchCalls[0].options.payload.grant_type, 'refresh_token');
  assert.equal(fetchCalls[0].options.payload.refresh_token, 'refresh-token-anterior-teste');
  assert.equal(fetchCalls[0].options.headers['enable-jwt'], '1');
  assert.equal(
    fetchCalls[0].options.headers.Authorization,
    `Basic ${Buffer.from('client-id-renovacao-teste:client-secret-renovacao-teste').toString('base64')}`
  );
  assert.equal(setPropertiesCalls.length, 1);
  assert.equal(values.get('BLING_ACCESS_TOKEN'), 'access-token-renovado-teste');
  assert.equal(values.get('BLING_REFRESH_TOKEN'), 'refresh-token-renovado-teste');
  assert.deepEqual(lockEvents, [
    ['wait', 30000], ['release'],
    ['wait', 30000], ['release']
  ]);
  assert.doesNotMatch(JSON.stringify([first, second, logEntries]), /(?:access|refresh|client)-token-.*-teste/);
  assert.doesNotMatch(JSON.stringify([first, second, logEntries]), /client-secret-renovacao-teste/);
});

test('renovação preserva o refresh token anterior quando a resposta válida o omite', async () => {
  const values = new Map([
    ['BLING_ACCESS_TOKEN', 'access-token-expirado'],
    ['BLING_REFRESH_TOKEN', 'refresh-token-vigente'],
    ['BLING_TOKEN_EXPIRES_AT', String(Date.now() - 1000)]
  ]);
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  for (const relative of ['src/config/Config.gs', 'src/config/Secrets.gs']) {
    vm.runInContext(await readFile(path.join(root, relative), 'utf8'), context, { filename: relative });
  }

  const result = vm.runInContext(`PRASecrets.refreshTokensAtomically(60, function () {
    return {
      access_token: 'access-token-novo',
      expires_in: 3600,
      token_type: 'Bearer'
    };
  })`, context);

  assert.equal(result.refreshed, true);
  assert.equal(values.get('BLING_ACCESS_TOKEN'), 'access-token-novo');
  assert.equal(values.get('BLING_REFRESH_TOKEN'), 'refresh-token-vigente');
});

test('falha de renovação preserva o último estado e não registra segredos', async () => {
  const original = {
    accessToken: 'access-token-anterior-falha',
    refreshToken: 'refresh-token-anterior-falha',
    expiresAt: String(Date.now() - 1000)
  };
  const values = new Map([
    ['BLING_CLIENT_ID', 'client-id-falha-teste'],
    ['BLING_CLIENT_SECRET', 'client-secret-falha-teste'],
    ['BLING_REDIRECT_URI', 'https://script.google.com/macros/s/deployment-teste/exec'],
    ['BLING_ACCESS_TOKEN', original.accessToken],
    ['BLING_REFRESH_TOKEN', original.refreshToken],
    ['BLING_TOKEN_EXPIRES_AT', original.expiresAt]
  ]);
  const setPropertiesCalls = [];
  const logEntries = [];
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => {
      setPropertiesCalls.push({ ...items });
      Object.entries(items).forEach(([key, value]) => values.set(key, value));
    },
    deleteProperty: (key) => values.delete(key)
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Utilities: {
      base64Encode: (value) => Buffer.from(value, 'utf8').toString('base64')
    },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 400,
        getContentText: () => JSON.stringify({
          error: 'invalid_grant',
          detail: 'refresh-token-anterior-falha'
        })
      })
    },
    console: { log: (entry) => logEntries.push(JSON.parse(entry)) },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON
  });

  for (const relative of [
    'src/config/Config.gs',
    'src/core/Logger.gs',
    'src/config/Secrets.gs',
    'src/services/OAuthService.gs'
  ]) {
    vm.runInContext(await readFile(path.join(root, relative), 'utf8'), context, { filename: relative });
  }

  const result = vm.runInContext('PRAOAuthService.refreshAccessToken(60)', context);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'refresh_failed');
  assert.equal(setPropertiesCalls.length, 0);
  assert.equal(values.get('BLING_ACCESS_TOKEN'), original.accessToken);
  assert.equal(values.get('BLING_REFRESH_TOKEN'), original.refreshToken);
  assert.equal(values.get('BLING_TOKEN_EXPIRES_AT'), original.expiresAt);
  assert.doesNotMatch(JSON.stringify([result, logEntries]), /access-token-anterior-falha/);
  assert.doesNotMatch(JSON.stringify([result, logEntries]), /refresh-token-anterior-falha/);
  assert.doesNotMatch(JSON.stringify([result, logEntries]), /client-secret-falha-teste/);
});

test('BlingClient centraliza GET autenticado e desembrulha respostas 2xx', async () => {
  const fetchCalls = [];
  const logEntries = [];
  let uuidSequence = 0;
  const context = vm.createContext({
    PRAConfig: {
      DEFAULTS: {
        API_BASE_URL: 'https://api.bling.com.br/Api/v3',
        TOKEN_MIN_VALIDITY_SECONDS: 60
      },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({ maxRetries: 0, pageSize: 100, maxPages: 1000 })
    },
    PRASecrets: {
      hasUsableAccessToken: () => true,
      getTokenStatus: () => ({ accessTokenPresent: true, expired: false })
    },
    PRAOAuthService: {
      refreshAccessToken: () => ({ ok: true, refreshed: false }),
      getValidAccessToken: () => 'access-token-sintetico-do-cliente'
    },
    PRALogger: {
      info: (event, metadata) => logEntries.push({ level: 'INFO', event, metadata }),
      warn: (event, metadata) => logEntries.push({ level: 'WARN', event, metadata }),
      error: (event, metadata) => logEntries.push({ level: 'ERROR', event, metadata })
    },
    PRAResilience: {
      acquireRateLimitSlot: () => 0,
      isRetryableStatus: (statusCode, networkFailure) => Boolean(networkFailure) ||
        statusCode === 408 || statusCode === 429 || statusCode >= 500,
      waitBeforeRetry: () => 0
    },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            data: [{ id: 101, codigo: 'SKU-SINTETICO', nome: 'Produto sintético' }]
          })
        };
      }
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    encodeURIComponent
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8'),
    context,
    { filename: 'src/clients/BlingClient.gs' }
  );

  const result = vm.runInContext(
    `PRABlingClient.get('/produtos', { limite: 1, pagina: 1 }, { operation: 'products.list.test' })`,
    context
  );

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    'https://api.bling.com.br/Api/v3/produtos?limite=1&pagina=1'
  );
  assert.equal(fetchCalls[0].options.method, 'get');
  assert.equal(fetchCalls[0].options.muteHttpExceptions, true);
  assert.equal(
    fetchCalls[0].options.headers.Authorization,
    'Bearer access-token-sintetico-do-cliente'
  );
  assert.equal(fetchCalls[0].options.headers['X-Correlation-Id'], result.correlationId);
  assert.equal(logEntries[0].event, 'bling_http_succeeded');
  assert.equal(logEntries[0].metadata.correlationId, result.correlationId);
  assert.doesNotMatch(JSON.stringify(logEntries), /access-token-sintetico-do-cliente/);
  assert.doesNotMatch(JSON.stringify(logEntries), /Produto sintético|SKU-SINTETICO/);
});

test('BlingClient padroniza 4xx, 5xx e falhas de rede sem vazar respostas', async () => {
  const logEntries = [];
  const responses = [
    {
      getResponseCode: () => 422,
      getContentText: () => JSON.stringify({
        error: { message: 'cliente-real-nao-pode-aparecer' }
      })
    },
    {
      getResponseCode: () => 503,
      getContentText: () => '<html>indisponível</html>'
    }
  ];
  let callIndex = 0;
  const context = vm.createContext({
    PRAConfig: {
      DEFAULTS: {
        API_BASE_URL: 'https://api.bling.com.br/Api/v3',
        TOKEN_MIN_VALIDITY_SECONDS: 60
      },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({ maxRetries: 0, pageSize: 100, maxPages: 1000 })
    },
    PRASecrets: {
      hasUsableAccessToken: () => true,
      getTokenStatus: () => ({ accessTokenPresent: true, expired: false })
    },
    PRAOAuthService: {
      refreshAccessToken: () => ({ ok: true, refreshed: false }),
      getValidAccessToken: () => 'token-que-nao-pode-aparecer'
    },
    PRALogger: {
      info: (event, metadata) => logEntries.push({ level: 'INFO', event, metadata }),
      warn: (event, metadata) => logEntries.push({ level: 'WARN', event, metadata }),
      error: (event, metadata) => logEntries.push({ level: 'ERROR', event, metadata })
    },
    PRAResilience: {
      acquireRateLimitSlot: () => 0,
      isRetryableStatus: (statusCode, networkFailure) => Boolean(networkFailure) ||
        statusCode === 408 || statusCode === 429 || statusCode >= 500,
      waitBeforeRetry: () => 0
    },
    Utilities: { getUuid: () => `correlation-${callIndex + 1}` },
    UrlFetchApp: {
      fetch: () => {
        if (callIndex === 2) throw new Error('detalhe-rede-que-nao-pode-aparecer');
        return responses[callIndex++];
      }
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    encodeURIComponent
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8'),
    context,
    { filename: 'src/clients/BlingClient.gs' }
  );

  const validation = vm.runInContext(`PRABlingClient.get('/produtos', {}, {})`, context);
  const unavailable = vm.runInContext(`PRABlingClient.get('/produtos', {}, {})`, context);
  callIndex = 2;
  const network = vm.runInContext(`PRABlingClient.get('/produtos', {}, {})`, context);

  assert.equal(validation.ok, false);
  assert.equal(validation.statusCode, 422);
  assert.equal(validation.error.code, 'validation_error');
  assert.equal(validation.error.retryable, false);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.error.code, 'service_unavailable');
  assert.equal(unavailable.error.retryable, true);
  assert.equal(network.statusCode, null);
  assert.equal(network.error.code, 'network_error');
  assert.equal(network.error.retryable, true);

  const serialized = JSON.stringify([validation, unavailable, network, logEntries]);
  assert.doesNotMatch(serialized, /cliente-real-nao-pode-aparecer/);
  assert.doesNotMatch(serialized, /token-que-nao-pode-aparecer/);
  assert.doesNotMatch(serialized, /detalhe-rede-que-nao-pode-aparecer/);
});

test('teste manual do Bling retorna somente metadados seguros', async () => {
  const main = await readFile(path.join(root, 'src/Main.gs'), 'utf8');
  const client = await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8');
  const health = await readFile(path.join(root, 'src/services/HealthService.gs'), 'utf8');

  assert.match(main, /function testBlingApiConnection\(\)/);
  assert.match(main, /PRAHealthService\.checkBlingConnectivity\(\)/);
  assert.match(health, /PRABlingClient\.probe\(\)/);
  assert.match(client, /get\('\/produtos', \{ pagina: 1, limite: 1 \}/);
  assert.match(client, /recordCount:/);
  assert.doesNotMatch(client, /console\.log\([^)]*(?:data|body|response)/i);
});

test('diagnóstico autorizado grava o último sucesso sob lock sem expor dados', async () => {
  const values = new Map();
  const lockEvents = [];
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value))
  };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_LAST_SUCCESS_AT: 'BLING_LAST_SUCCESS_AT',
        BLING_LAST_SUCCESS_CORRELATION_ID: 'BLING_LAST_SUCCESS_CORRELATION_ID'
      },
      getPublicSnapshot: () => ({ validation: { valid: true } })
    },
    PRABlingClient: {
      getSecurityStatus: () => ({
        configured: true,
        authenticated: true,
        token: { accessTokenPresent: true, refreshTokenPresent: true, expired: false }
      }),
      probe: () => ({
        ok: true,
        code: 'connected',
        statusCode: 200,
        correlationId: 'correlation-authorized-001',
        checkedAt: '2026-09-10T02:25:38.326Z',
        recordCount: 1,
        data: [{ id: 'produto-que-nao-pode-aparecer' }]
      })
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({
        waitLock: (milliseconds) => lockEvents.push(['wait', milliseconds]),
        releaseLock: () => lockEvents.push(['release'])
      })
    },
    Utilities: { getUuid: () => 'correlation-local-001' },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/services/HealthService.gs'), 'utf8'),
    context,
    { filename: 'src/services/HealthService.gs' }
  );

  const result = vm.runInContext('PRAHealthService.checkBlingConnectivity()', context);
  assert.equal(result.state, 'authorized');
  assert.equal(result.code, 'connected');
  assert.equal(result.statusCode, 200);
  assert.equal(result.checkedAt, '2026-09-10T02:25:38.326Z');
  assert.equal(result.correlationId, 'correlation-authorized-001');
  assert.equal(result.lastSuccessfulAt, result.checkedAt);
  assert.equal(result.lastSuccessfulCorrelationId, result.correlationId);
  assert.equal(values.get('BLING_LAST_SUCCESS_AT'), result.checkedAt);
  assert.equal(values.get('BLING_LAST_SUCCESS_CORRELATION_ID'), result.correlationId);
  assert.deepEqual(lockEvents, [['wait', 30000], ['release']]);
  assert.doesNotMatch(JSON.stringify(result), /produto-que-nao-pode-aparecer|accessToken|refreshToken/);
});

test('diagnóstico expirado não consulta o Bling e preserva o último sucesso', async () => {
  const values = new Map([
    ['BLING_LAST_SUCCESS_AT', '2026-09-09T21:00:00.000Z'],
    ['BLING_LAST_SUCCESS_CORRELATION_ID', 'correlation-previous-001']
  ]);
  let probeCount = 0;
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_LAST_SUCCESS_AT: 'BLING_LAST_SUCCESS_AT',
        BLING_LAST_SUCCESS_CORRELATION_ID: 'BLING_LAST_SUCCESS_CORRELATION_ID'
      }
    },
    PRABlingClient: {
      getSecurityStatus: () => ({
        configured: true,
        authenticated: false,
        token: { accessTokenPresent: true, refreshTokenPresent: true, expired: true }
      }),
      probe: () => { probeCount += 1; }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => values.has(key) ? values.get(key) : null,
        setProperties: () => assert.fail('não deve gravar em estado expirado')
      })
    },
    LockService: { getScriptLock: () => assert.fail('não deve obter lock em estado expirado') },
    Utilities: { getUuid: () => 'correlation-expired-001' },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/services/HealthService.gs'), 'utf8'),
    context,
    { filename: 'src/services/HealthService.gs' }
  );

  const result = vm.runInContext('PRAHealthService.checkBlingConnectivity()', context);
  assert.equal(result.state, 'expired');
  assert.equal(result.code, 'token_expired_or_expiring');
  assert.equal(result.correlationId, 'correlation-expired-001');
  assert.equal(result.lastSuccessfulAt, '2026-09-09T21:00:00.000Z');
  assert.equal(result.lastSuccessfulCorrelationId, 'correlation-previous-001');
  assert.equal(probeCount, 0);
});

test('diagnóstico indisponível preserva a evidência do último acesso autorizado', async () => {
  const values = new Map([
    ['BLING_LAST_SUCCESS_AT', '2026-09-09T21:00:00.000Z'],
    ['BLING_LAST_SUCCESS_CORRELATION_ID', 'correlation-previous-001']
  ]);
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_LAST_SUCCESS_AT: 'BLING_LAST_SUCCESS_AT',
        BLING_LAST_SUCCESS_CORRELATION_ID: 'BLING_LAST_SUCCESS_CORRELATION_ID'
      }
    },
    PRABlingClient: {
      getSecurityStatus: () => ({
        configured: true,
        authenticated: true,
        token: { accessTokenPresent: true, refreshTokenPresent: true, expired: false }
      }),
      probe: () => ({
        ok: false,
        code: 'service_unavailable',
        statusCode: 503,
        correlationId: 'correlation-unavailable-001',
        checkedAt: '2026-09-10T02:30:00.000Z'
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => values.has(key) ? values.get(key) : null,
        setProperties: () => assert.fail('não deve gravar em estado indisponível')
      })
    },
    LockService: { getScriptLock: () => assert.fail('não deve obter lock em falha') },
    Utilities: { getUuid: () => 'correlation-local-002' },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/services/HealthService.gs'), 'utf8'),
    context,
    { filename: 'src/services/HealthService.gs' }
  );

  const result = vm.runInContext('PRAHealthService.checkBlingConnectivity()', context);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.code, 'service_unavailable');
  assert.equal(result.statusCode, 503);
  assert.equal(result.checkedAt, '2026-09-10T02:30:00.000Z');
  assert.equal(result.correlationId, 'correlation-unavailable-001');
  assert.equal(result.lastSuccessfulAt, '2026-09-09T21:00:00.000Z');
  assert.equal(result.lastSuccessfulCorrelationId, 'correlation-previous-001');
});

test('configuração de paginação e resiliência usa padrões seguros e limites válidos', async () => {
  const values = new Map([
    ['BLING_CLIENT_ID', 'client-id-de-teste'],
    ['BLING_CLIENT_SECRET', 'client-secret-de-teste'],
    ['BLING_REDIRECT_URI', 'https://script.google.com/macros/s/teste/exec']
  ]);
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    Date,
    Number,
    Object,
    String,
    Boolean
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/config/Config.gs'), 'utf8'),
    context,
    { filename: 'src/config/Config.gs' }
  );

  const policy = vm.runInContext('PRAConfig.getRequestPolicy()', context);
  assert.equal(policy.requestsPerSecond, 3);
  assert.equal(policy.pageSize, 100);
  assert.equal(policy.maxRetries, 3);
  assert.equal(policy.backoffBaseMs, 1000);
  assert.equal(policy.backoffMaxMs, 8000);
  assert.equal(policy.maxPages, 1000);
  assert.equal(policy.maxPagesPerRun, 10);
  assert.equal(policy.maxOrderDetailsPerRun, 20);
  assert.equal(vm.runInContext('PRAConfig.validate().valid', context), true);
  const snapshot = vm.runInContext('PRAConfig.getPublicSnapshot()', context);
  assert.equal('BLING_MAX_PAGES_PER_RUN' in snapshot.configuredProperties, true);
  assert.equal('BLING_MAX_ORDER_DETAILS_PER_RUN' in snapshot.configuredProperties, true);
  assert.equal('BLING_PRODUCTS_SYNC_CHECKPOINT' in snapshot.configuredProperties, false);
  assert.equal('BLING_LAST_PRODUCTS_SYNC_RUN' in snapshot.configuredProperties, false);
  assert.equal('BLING_ORDER_DETAILS_QUEUE_INDEX' in snapshot.configuredProperties, false);
  assert.equal('BLING_NEXT_REQUEST_AT' in snapshot.configuredProperties, false);
  assert.equal('BLING_LAST_SUCCESS_AT' in snapshot.configuredProperties, false);
  assert.equal('BLING_LAST_SUCCESS_CORRELATION_ID' in snapshot.configuredProperties, false);

  values.set('BLING_REQUESTS_PER_SECOND', '4');
  const invalid = vm.runInContext('PRAConfig.validate()', context);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.invalid.includes('BLING_REQUESTS_PER_SECOND'));
});

test('rate limiter compartilha intervalo sob lock e backoff cresce até o teto', async () => {
  const values = new Map();
  const lockEvents = [];
  const sleeps = [];
  let now = 1000;
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { BLING_NEXT_REQUEST_AT: 'BLING_NEXT_REQUEST_AT' },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({
        requestsPerSecond: 2,
        pageSize: 100,
        maxRetries: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 8000,
        maxPages: 1000
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => values.has(key) ? values.get(key) : null,
        setProperty: (key, value) => values.set(key, value)
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: (milliseconds) => lockEvents.push(['wait', milliseconds]),
        releaseLock: () => lockEvents.push(['release'])
      })
    },
    Utilities: {
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    },
    Date: { now: () => now },
    Math,
    Number,
    Object,
    String,
    Boolean
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/core/Resilience.gs'), 'utf8'),
    context,
    { filename: 'src/core/Resilience.gs' }
  );

  assert.equal(vm.runInContext('PRAResilience.acquireRateLimitSlot()', context), 0);
  assert.equal(vm.runInContext('PRAResilience.acquireRateLimitSlot()', context), 500);
  assert.deepEqual(sleeps, [500]);
  assert.deepEqual(lockEvents, [
    ['wait', 30000], ['release'],
    ['wait', 30000], ['release']
  ]);
  assert.equal(values.get('BLING_NEXT_REQUEST_AT'), '2000');
  assert.deepEqual(
    Array.from(vm.runInContext('[1, 2, 3, 4, 5].map(PRAResilience.getBackoffDelay)', context)),
    [1000, 2000, 4000, 8000, 8000]
  );
});

test('BlingClient repete 429 e 5xx com backoff e preserva o correlationId', async () => {
  const responses = [429, 503, 200];
  const fetchCalls = [];
  const delays = [];
  const logEntries = [];
  const context = vm.createContext({
    PRAConfig: {
      DEFAULTS: {
        API_BASE_URL: 'https://api.bling.com.br/Api/v3',
        TOKEN_MIN_VALIDITY_SECONDS: 60
      },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({ maxRetries: 3, pageSize: 100, maxPages: 1000 })
    },
    PRASecrets: {
      hasUsableAccessToken: () => true,
      getTokenStatus: () => ({ accessTokenPresent: true, expired: false })
    },
    PRAOAuthService: {
      refreshAccessToken: () => ({ ok: true, refreshed: false }),
      getValidAccessToken: () => 'token-sintetico-de-retentativa'
    },
    PRAResilience: {
      acquireRateLimitSlot: () => 0,
      isRetryableStatus: (statusCode, networkFailure) => Boolean(networkFailure) ||
        statusCode === 408 || statusCode === 429 || statusCode >= 500,
      waitBeforeRetry: (attempt) => {
        const delay = 1000 * Math.pow(2, attempt - 1);
        delays.push(delay);
        return delay;
      }
    },
    PRALogger: {
      info: (event, metadata) => logEntries.push({ event, metadata }),
      warn: (event, metadata) => logEntries.push({ event, metadata }),
      error: (event, metadata) => logEntries.push({ event, metadata })
    },
    Utilities: { getUuid: () => 'correlation-retry-001' },
    UrlFetchApp: {
      fetch: (url, options) => {
        const statusCode = responses[fetchCalls.length];
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => statusCode,
          getContentText: () => statusCode === 200 ?
            JSON.stringify({ data: [{ id: 1 }] }) :
            JSON.stringify({ error: 'conteudo-nao-deve-ser-logado' })
        };
      }
    },
    Date,
    Math,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    encodeURIComponent
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8'),
    context,
    { filename: 'src/clients/BlingClient.gs' }
  );

  const result = vm.runInContext(
    `PRABlingClient.get('/produtos', {}, { operation: 'products.retry.test' })`,
    context
  );

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(fetchCalls.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.ok(fetchCalls.every((call) =>
    call.options.headers['X-Correlation-Id'] === 'correlation-retry-001'
  ));
  assert.equal(logEntries.filter((entry) => entry.event === 'bling_http_retry_scheduled').length, 2);
  assert.doesNotMatch(JSON.stringify(logEntries), /conteudo-nao-deve-ser-logado|token-sintetico/);
});

test('BlingClient não repete erros permanentes', async () => {
  let fetchCount = 0;
  const delays = [];
  const context = vm.createContext({
    PRAConfig: {
      DEFAULTS: {
        API_BASE_URL: 'https://api.bling.com.br/Api/v3',
        TOKEN_MIN_VALIDITY_SECONDS: 60
      },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({ maxRetries: 3, pageSize: 100, maxPages: 1000 })
    },
    PRASecrets: {
      hasUsableAccessToken: () => true,
      getTokenStatus: () => ({ accessTokenPresent: true, expired: false })
    },
    PRAOAuthService: {
      refreshAccessToken: () => ({ ok: true, refreshed: false }),
      getValidAccessToken: () => 'token-sintetico'
    },
    PRAResilience: {
      acquireRateLimitSlot: () => 0,
      isRetryableStatus: (statusCode) => statusCode === 408 || statusCode === 429 || statusCode >= 500,
      waitBeforeRetry: (attempt) => delays.push(attempt)
    },
    PRALogger: { info: () => {}, warn: () => {}, error: () => {} },
    Utilities: { getUuid: () => 'correlation-permanent-001' },
    UrlFetchApp: {
      fetch: () => {
        fetchCount += 1;
        return {
          getResponseCode: () => 422,
          getContentText: () => JSON.stringify({ error: 'inválido' })
        };
      }
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    encodeURIComponent
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8'),
    context,
    { filename: 'src/clients/BlingClient.gs' }
  );

  const result = vm.runInContext(`PRABlingClient.get('/produtos', {}, {})`, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'validation_error');
  assert.equal(result.attempts, 1);
  assert.equal(fetchCount, 1);
  assert.deepEqual(delays, []);
});

test('paginador avança páginas sem pular nem repetir registros', async () => {
  const fetchCalls = [];
  const pages = {
    1: [{ id: 1 }, { id: 2 }],
    2: [{ id: 3 }]
  };
  let uuidSequence = 0;
  const context = vm.createContext({
    PRAConfig: {
      DEFAULTS: {
        API_BASE_URL: 'https://api.bling.com.br/Api/v3',
        TOKEN_MIN_VALIDITY_SECONDS: 60
      },
      validate: () => ({ valid: true }),
      getRequestPolicy: () => ({ maxRetries: 0, pageSize: 100, maxPages: 1000 })
    },
    PRASecrets: {
      hasUsableAccessToken: () => true,
      getTokenStatus: () => ({ accessTokenPresent: true, expired: false })
    },
    PRAOAuthService: {
      refreshAccessToken: () => ({ ok: true, refreshed: false }),
      getValidAccessToken: () => 'token-sintetico-de-paginacao'
    },
    PRAResilience: {
      acquireRateLimitSlot: () => 0,
      isRetryableStatus: () => false,
      waitBeforeRetry: () => 0
    },
    PRALogger: { info: () => {}, warn: () => {}, error: () => {} },
    Utilities: {
      getUuid: () => `pagination-correlation-${++uuidSequence}`
    },
    UrlFetchApp: {
      fetch: (url) => {
        fetchCalls.push(url);
        const page = Number(new URL(url).searchParams.get('pagina'));
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ data: pages[page] || [] })
        };
      }
    },
    URL,
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    encodeURIComponent
  });

  vm.runInContext(
    await readFile(path.join(root, 'src/clients/BlingClient.gs'), 'utf8'),
    context,
    { filename: 'src/clients/BlingClient.gs' }
  );

  const result = vm.runInContext(
    `PRABlingClient.getAllPages('/produtos', { criterio: 'ATIVOS' }, {
      operation: 'products.list.pagination.test',
      pageSize: 2,
      maxPages: 5
    })`,
    context
  );

  assert.equal(result.ok, true);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.pagesFetched, 2);
  assert.equal(result.pagination.recordCount, 3);
  assert.deepEqual(Array.from(result.data, (item) => item.id), [1, 2, 3]);
  assert.deepEqual(fetchCalls, [
    'https://api.bling.com.br/Api/v3/produtos?criterio=ATIVOS&limite=2&pagina=1',
    'https://api.bling.com.br/Api/v3/produtos?criterio=ATIVOS&limite=2&pagina=2'
  ]);
});

function createInitialOrdersContext({ pages, pageSize = 2, maxPagesPerRun = 10, statusId = '77' } = {}) {
  const values = new Map();
  const calls = [];
  const logs = [];
  let uuid = 0;
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_STATUS_ATENDIDO_ID: 'BLING_STATUS_ATENDIDO_ID',
        BLING_INITIAL_ORDERS_CHECKPOINT: 'BLING_INITIAL_ORDERS_CHECKPOINT',
        BLING_LAST_INITIAL_ORDERS_RUN: 'BLING_LAST_INITIAL_ORDERS_RUN'
      },
      getPublicValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      getRequestPolicy: () => ({
        pageSize,
        maxPages: 100,
        maxPagesPerRun
      })
    },
    PRABlingClient: {
      get: (_path, query) => {
        calls.push(query);
        const page = Number(query.pagina);
        const pageResult = pages[page];
        if (pageResult && pageResult.error) {
          return {
            ok: false,
            statusCode: pageResult.statusCode || 503,
            correlationId: `corr-${page}`,
            error: { code: pageResult.error }
          };
        }
        return {
          ok: true,
          statusCode: 200,
          correlationId: `corr-${page}`,
          data: pageResult ? pageResult.data : []
        };
      }
    },
    PRALogger: {
      info: (event, metadata) => logs.push({ level: 'INFO', event, metadata }),
      warn: (event, metadata) => logs.push({ level: 'WARN', event, metadata }),
      error: (event, metadata) => logs.push({ level: 'ERROR', event, metadata })
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Utilities: { getUuid: () => `run-${++uuid}` },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array
  });
  return { context, values, calls, logs, statusId };
}

test('carga inicial valida período e situação antes de consultar o Bling', async () => {
  const { context, calls } = createInitialOrdersContext({ pages: {} });
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrdersInitialLoadJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/OrdersInitialLoadJob.gs' }
  );

  const invalidPeriod = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-02-31', endDate: '2026-03-01' })`,
    context
  );
  assert.equal(invalidPeriod.ok, false);
  assert.equal(invalidPeriod.code, 'period_invalid');
  assert.equal(calls.length, 0);

  const missingStatus = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-02-01', endDate: '2026-03-01' })`,
    context
  );
  assert.equal(missingStatus.ok, false);
  assert.equal(missingStatus.code, 'status_configuration_missing');
  assert.equal(calls.length, 0);
});

test('carga inicial filtra Atendido, conclui páginas e guarda somente resumo', async () => {
  const { context, values, calls, logs } = createInitialOrdersContext({
    pages: {
      1: { data: [{ id: 101 }, { id: 102 }] },
      2: { data: [{ id: 103 }] }
    }
  });
  values.set('BLING_STATUS_ATENDIDO_ID', '77');
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrdersInitialLoadJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/OrdersInitialLoadJob.gs' }
  );

  const result = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-02-01', endDate: '2026-03-01' })`,
    context
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'initial_load_completed');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.recordsFetched, 3);
  assert.equal(result.nextPage, 3);
  assert.equal(calls[0]['idsSituacoes[]'], '77');
  assert.equal(calls[0].dataInicial, '2026-02-01');
  assert.equal(calls[0].dataFinal, '2026-03-01');
  assert.equal(values.has('BLING_INITIAL_ORDERS_CHECKPOINT'), false);
  const savedRun = JSON.parse(values.get('BLING_LAST_INITIAL_ORDERS_RUN'));
  assert.equal(savedRun.recordsFetched, 3);
  assert.doesNotMatch(JSON.stringify([result, savedRun, logs]), /101|102|103/);
});

test('carga inicial retoma da próxima página e não duplica o checkpoint', async () => {
  const fixture = createInitialOrdersContext({
    pages: {
      1: { data: [{ id: 201 }, { id: 202 }] },
      2: { data: [{ id: 203 }] }
    },
    maxPagesPerRun: 1
  });
  fixture.values.set('BLING_STATUS_ATENDIDO_ID', fixture.statusId);
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrdersInitialLoadJob.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/OrdersInitialLoadJob.gs' }
  );

  const first = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-01-01', endDate: '2026-01-31' })`,
    fixture.context
  );
  assert.equal(first.status, 'in_progress');
  assert.equal(first.nextPage, 2);
  const checkpoint = JSON.parse(fixture.values.get('BLING_INITIAL_ORDERS_CHECKPOINT'));
  assert.equal(checkpoint.nextPage, 2);

  const second = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-01-01', endDate: '2026-01-31' })`,
    fixture.context
  );
  assert.equal(second.status, 'completed');
  assert.deepEqual(fixture.calls.map((query) => Number(query.pagina)), [1, 2]);
  assert.equal(fixture.values.has('BLING_INITIAL_ORDERS_CHECKPOINT'), false);
});

test('falha de página preserva o checkpoint sem avançar', async () => {
  const fixture = createInitialOrdersContext({
    pages: { 1: { error: 'service_unavailable', statusCode: 503 } }
  });
  fixture.values.set('BLING_STATUS_ATENDIDO_ID', fixture.statusId);
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrdersInitialLoadJob.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/OrdersInitialLoadJob.gs' }
  );

  const result = vm.runInContext(
    `PRAOrdersInitialLoad.run({ startDate: '2026-01-01', endDate: '2026-01-31' })`,
    fixture.context
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'page_fetch_failed');
  assert.equal(result.nextPage, 1);
  const checkpoint = JSON.parse(fixture.values.get('BLING_INITIAL_ORDERS_CHECKPOINT'));
  assert.equal(checkpoint.nextPage, 1);
  assert.equal(checkpoint.pagesFetched, 0);
  assert.equal(checkpoint.recordsFetched, 0);
});

function createOrderDetailsQueueContext() {
  const values = new Map();
  let uuid = 0;
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperty: (key, value) => values.set(key, value),
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { BLING_ORDER_DETAILS_QUEUE_INDEX: 'BLING_ORDER_DETAILS_QUEUE_INDEX' }
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Utilities: { getUuid: () => `queue-${++uuid}` },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array
  });
  return { context, values };
}

test('fila de detalhes fragmenta páginas, deduplica IDs e não persiste payloads', async () => {
  const fixture = createOrderDetailsQueueContext();
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrderDetailsQueue.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/OrderDetailsQueue.gs' }
  );

  const first = vm.runInContext(`PRAOrderDetailsQueue.enqueuePage([
    { id: 101, contato: { nome: 'CLIENTE NAO DEVE SER SALVO' } },
    { id: 102, itens: [{ codigo: 'SKU-NAO-DEVE-SER-SALVO' }] }
  ], 1, { runId: 'run-seguro' })`, fixture.context);
  const duplicate = vm.runInContext(`PRAOrderDetailsQueue.enqueuePage([
    { id: 101 }, { id: 102 }
  ], 1, { runId: 'run-seguro' })`, fixture.context);
  const second = vm.runInContext(`PRAOrderDetailsQueue.enqueuePage([
    { id: 102 }, { id: 103 }
  ], 2, { runId: 'run-seguro' })`, fixture.context);

  assert.equal(first.added, 2);
  assert.equal(duplicate.added, 0);
  assert.equal(second.added, 1);
  assert.equal(second.pending, 3);
  assert.doesNotMatch(JSON.stringify([...fixture.values]), /CLIENTE|SKU-NAO/);

  const initialBatch = vm.runInContext('PRAOrderDetailsQueue.peek(2)', fixture.context);
  assert.deepEqual(Array.from(initialBatch, (entry) => String(entry.id)), ['101', '102']);
  vm.runInContext(`PRAOrderDetailsQueue.acknowledge([
    { id: 101, status: 'success' },
    { id: 102, status: 'retryable_failure' }
  ])`, fixture.context);
  const nextBatch = vm.runInContext('PRAOrderDetailsQueue.peek(2)', fixture.context);
  assert.deepEqual(Array.from(nextBatch, (entry) => String(entry.id)), ['103', '102']);
  assert.equal(Number(nextBatch[1].attempts), 1);
});

test('coletor de detalhes preserva campos de itens e registra erro permanente', async () => {
  const calls = [];
  const persisted = [];
  const acknowledgements = [];
  const logs = [];
  const context = vm.createContext({
    PRAExecutionLease: {
      acquire: () => ({ acquired: true }),
      release: () => true
    },
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      getRequestPolicy: () => ({ maxOrderDetailsPerRun: 20 }),
      getPublicValue: () => 'spreadsheet-test'
    },
    PRAOrderDetailsQueue: {
      peek: () => [{ id: '101', attempts: 0 }, { id: '102', attempts: 1 }],
      getSummary: () => ({ pending: 2 }),
      acknowledge: (outcomes) => {
        acknowledgements.push(outcomes);
        return { pending: 0 };
      }
    },
    PRABlingClient: {
      get: (requestPath) => {
        calls.push(requestPath);
        if (requestPath.endsWith('/101')) {
          return {
            ok: true,
            statusCode: 200,
            correlationId: 'corr-success',
            data: {
              id: 101,
              itens: [{
                id: 501,
                codigo: 'SKU-TESTE',
                quantidade: 2,
                valor: 19.9,
                desconto: 1,
                produto: { id: 9001 }
              }]
            }
          };
        }
        return {
          ok: false,
          statusCode: 404,
          correlationId: 'corr-not-found',
          error: { code: 'not_found', retryable: false }
        };
      }
    },
    PRAOrderDetailsStore: {
      persistBatch: (details, failures, metadata) => {
        persisted.push({ details, failures, metadata });
        return {
          ordersStored: details.length,
          itemsStored: details.flatMap((detail) => detail.itens).length,
          errorsStored: failures.length,
          updatedAt: '2026-09-11T15:00:00.000Z'
        };
      }
    },
    PRALogger: {
      info: (event, metadata) => logs.push({ event, metadata }),
      error: (event, metadata) => logs.push({ event, metadata })
    },
    Utilities: { getUuid: () => 'detail-run-1' },
    Date,
    Number,
    Object,
    String,
    Boolean,
    Array,
    JSON
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/RuntimeBudget.gs'), 'utf8'),
    context,
    { filename: 'src/core/RuntimeBudget.gs' }
  );
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrderDetailsJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/OrderDetailsJob.gs' }
  );

  const result = vm.runInContext('PRAOrderDetailsJob.run({ maxOrders: 2 })', context);
  assert.deepEqual(calls, ['/pedidos/vendas/101', '/pedidos/vendas/102']);
  assert.equal(persisted[0].details[0].itens[0].codigo, 'SKU-TESTE');
  assert.equal(persisted[0].details[0].itens[0].produto.id, 9001);
  assert.equal(persisted[0].details[0].itens[0].quantidade, 2);
  assert.equal(persisted[0].details[0].itens[0].valor, 19.9);
  assert.equal(persisted[0].details[0].itens[0].desconto, 1);
  assert.equal(persisted[0].failures[0].errorCode, 'not_found');
  assert.equal(acknowledgements[0][1].status, 'permanent_failure');
  assert.equal(result.status, 'completed_with_errors');
  assert.equal(result.ordersStored, 1);
  assert.equal(result.itemsStored, 1);
  assert.equal(result.errorsStored, 1);
  assert.doesNotMatch(JSON.stringify([result, logs]), /SKU-TESTE|9001|corr-not-found/);
});

test('falha retomável permanece na fila e falha de armazenamento não confirma lote', async () => {
  let acknowledgeCalls = 0;
  let storageShouldFail = false;
  const context = vm.createContext({
    PRAExecutionLease: {
      acquire: () => ({ acquired: true }),
      release: () => true
    },
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      getRequestPolicy: () => ({ maxOrderDetailsPerRun: 20 }),
      getPublicValue: () => 'spreadsheet-test'
    },
    PRAOrderDetailsQueue: {
      peek: () => [{ id: '201', attempts: 0 }],
      getSummary: () => ({ pending: 1 }),
      acknowledge: (outcomes) => {
        acknowledgeCalls += 1;
        assert.equal(outcomes[0].status, 'retryable_failure');
        return { pending: 1 };
      }
    },
    PRABlingClient: {
      get: () => ({
        ok: false,
        statusCode: 503,
        correlationId: 'corr-retry',
        error: { code: 'service_unavailable', retryable: true }
      })
    },
    PRAOrderDetailsStore: {
      persistBatch: (_details, failures) => {
        if (storageShouldFail) throw new Error('storage unavailable');
        return {
          ordersStored: 0,
          itemsStored: 0,
          errorsStored: failures.length,
          updatedAt: '2026-09-11T15:00:00.000Z'
        };
      }
    },
    PRALogger: { info: () => {}, error: () => {} },
    Utilities: { getUuid: () => 'detail-run-2' },
    Date,
    Number,
    Object,
    String,
    Boolean,
    Array,
    JSON
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/RuntimeBudget.gs'), 'utf8'),
    context,
    { filename: 'src/core/RuntimeBudget.gs' }
  );
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrderDetailsJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/OrderDetailsJob.gs' }
  );

  const retry = vm.runInContext('PRAOrderDetailsJob.run({ maxOrders: 1 })', context);
  assert.equal(retry.status, 'in_progress');
  assert.equal(retry.retryableFailures, 1);
  assert.equal(retry.pending, 1);
  assert.equal(acknowledgeCalls, 1);

  storageShouldFail = true;
  const failedStore = vm.runInContext('PRAOrderDetailsJob.run({ maxOrders: 1 })', context);
  assert.equal(failedStore.ok, false);
  assert.equal(failedStore.code, 'order_details_storage_failed');
  assert.equal(acknowledgeCalls, 1);
});

test('detalhes persistidos ativam janelas de recálculo somente com fila e erros zerados', async () => {
  let activations = 0;
  const context = vm.createContext({
    PRAExecutionLease: {
      acquire: () => ({ acquired: true }),
      release: () => true
    },
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      getRequestPolicy: () => ({ maxOrderDetailsPerRun: 20, executionBudgetMs: 270000 }),
      getPublicValue: () => 'spreadsheet-test'
    },
    PRAOrderDetailsQueue: {
      peek: () => [{ id: '301', attempts: 0 }],
      getSummary: () => ({ pending: 1 }),
      acknowledge: () => ({ pending: 0 })
    },
    PRABlingClient: {
      get: () => ({ ok: true, data: { id: 301, itens: [] } })
    },
    PRAOrderDetailsStore: {
      persistBatch: () => ({
        ordersStored: 1,
        itemsStored: 0,
        errorsStored: 0,
        unresolvedErrors: 0,
        updatedAt: '2026-09-12T00:00:00.000Z'
      })
    },
    PRARecalculationWindowStore: {
      activateWaitingWindows: () => {
        activations += 1;
        return { ok: true, activated: 1 };
      }
    },
    PRALogger: { info() {}, error() {} },
    Utilities: { getUuid: () => 'detail-run-activation' },
    Date, Number, Object, String, Boolean, Array, JSON, Math
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/RuntimeBudget.gs'), 'utf8'),
    context,
    { filename: 'src/core/RuntimeBudget.gs' }
  );
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/OrderDetailsJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/OrderDetailsJob.gs' }
  );

  const result = vm.runInContext('PRAOrderDetailsJob.run({ maxOrders: 1 })', context);
  assert.equal(result.status, 'completed');
  assert.equal(result.recalcWindowsActivated, 1);
  assert.equal(activations, 1);
});

class FakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }

  setValues(values) {
    values.forEach((row, rowOffset) => {
      const targetRow = this.row - 1 + rowOffset;
      if (!this.sheet.rows[targetRow]) this.sheet.rows[targetRow] = [];
      row.forEach((cell, columnOffset) => {
        this.sheet.rows[targetRow][this.column - 1 + columnOffset] = cell;
      });
    });
    return this;
  }

  clearContent() {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const targetRow = this.row - 1 + rowOffset;
      if (!this.sheet.rows[targetRow]) continue;
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.rows[targetRow][this.column - 1 + columnOffset] = '';
      }
    }
    while (this.sheet.rows.length > 0 && this.sheet.rows.at(-1).every((cell) => cell === '')) {
      this.sheet.rows.pop();
    }
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = new Map();
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

test('armazenamento substitui pedido e itens pela chave sem duplicação', async () => {
  const spreadsheet = new FakeSpreadsheet();
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'spreadsheet-test'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    Array,
    JSON
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/SheetWriter.gs'), 'utf8'),
    context,
    { filename: 'src/core/SheetWriter.gs' }
  );
  vm.runInContext(
    await readFile(path.join(root, 'src/repositories/OrderDetailsStore.gs'), 'utf8'),
    context,
    { filename: 'src/repositories/OrderDetailsStore.gs' }
  );

  vm.runInContext(`PRAOrderDetailsStore.persistBatch([{
    id: 301,
    numero: 7001,
    data: '2026-08-01',
    situacao: { id: 9 },
    totalProdutos: 30,
    total: 35,
    itens: [
      { id: 801, codigo: 'SKU-A', quantidade: 1, valor: 10, desconto: 0, produto: { id: 901 } },
      { id: 802, codigo: 'SKU-B', quantidade: 2, valor: 10, desconto: 0, produto: { id: 902 } }
    ]
  }], [], { runId: 'run-a' })`, context);

  vm.runInContext(`PRAOrderDetailsStore.persistBatch([{
    id: 301,
    numero: 7001,
    data: '2026-08-01',
    situacao: { id: 9 },
    totalProdutos: 18,
    total: 18,
    itens: [
      { id: 801, codigo: 'SKU-A', quantidade: 2, valor: 9, desconto: 1, produto: { id: 901 } }
    ]
  }], [], { runId: 'run-b' })`, context);

  const orders = spreadsheet.getSheetByName('raw_orders').rows;
  const items = spreadsheet.getSheetByName('raw_order_items').rows;
  assert.equal(orders.length, 2);
  assert.equal(items.length, 2);
  assert.equal(String(items[1][0]), '301:801');
  assert.equal(String(items[1][1]), '301');
  assert.equal(String(items[1][3]), '901');
  assert.equal(items[1][4], 'SKU-A');
  assert.equal(items[1][6], 2);
  assert.equal(items[1][7], 9);
  assert.equal(items[1][8], 1);
  assert.equal(items[1][11], 'run-b');
});

function createProductsSyncContext({ pages, pageSize = 2, maxPages = 100, maxPagesPerRun = 10 } = {}) {
  const values = new Map([['DATA_SPREADSHEET_ID', 'spreadsheet-test']]);
  const calls = [];
  const persisted = [];
  const logs = [];
  let uuid = 0;
  const scriptProperties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  const store = {
    shouldFail: false,
    persistPage: (products, metadata) => {
      if (store.shouldFail) throw new Error('storage unavailable');
      persisted.push({ products, metadata });
      return {
        productsStored: products.length,
        parentLinksStored: products.filter((product) => Number(product.idProdutoPai || 0) > 0).length,
        updatedAt: '2026-09-11T16:00:00.000Z'
      };
    }
  };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID',
        BLING_PRODUCTS_SYNC_CHECKPOINT: 'BLING_PRODUCTS_SYNC_CHECKPOINT',
        BLING_LAST_PRODUCTS_SYNC_RUN: 'BLING_LAST_PRODUCTS_SYNC_RUN'
      },
      getPublicValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      getRequestPolicy: () => ({ pageSize, maxPages, maxPagesPerRun })
    },
    PRABlingClient: {
      get: (requestPath, query, metadata) => {
        calls.push({ requestPath, query, metadata });
        const page = Number(query.pagina);
        const pageResult = pages[page];
        if (pageResult && pageResult.error) {
          return {
            ok: false,
            statusCode: pageResult.statusCode || 503,
            correlationId: `products-corr-${page}`,
            error: { code: pageResult.error }
          };
        }
        return {
          ok: true,
          statusCode: 200,
          correlationId: `products-corr-${page}`,
          data: pageResult ? pageResult.data : []
        };
      }
    },
    PRAProductStore: store,
    PRALogger: {
      info: (event, metadata) => logs.push({ level: 'INFO', event, metadata }),
      warn: (event, metadata) => logs.push({ level: 'WARN', event, metadata }),
      error: (event, metadata) => logs.push({ level: 'ERROR', event, metadata })
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Utilities: { getUuid: () => `products-run-${++uuid}` },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array
  });
  return { context, values, calls, persisted, logs, store };
}

test('coleta de produtos conclui páginas e preserva relações sem expor catálogo', async () => {
  const fixture = createProductsSyncContext({
    pages: {
      1: { data: [
        { id: 1101, idProdutoPai: 0, codigo: 'SKU-PAI-TESTE' },
        { id: 1102, idProdutoPai: 1101, codigo: 'SKU-FILHO-TESTE' }
      ] },
      2: { data: [{ id: 1103, idProdutoPai: 0, codigo: 'SKU-SIMPLES-TESTE' }] }
    }
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/ProductsSyncJob.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/ProductsSyncJob.gs' }
  );

  const result = vm.runInContext('PRAProductsSyncJob.run({ reset: true })', fixture.context);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'products_sync_completed');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.recordsFetched, 3);
  assert.equal(result.parentLinksFound, 1);
  assert.deepEqual(fixture.calls.map((call) => call.requestPath), ['/produtos', '/produtos']);
  assert.deepEqual(fixture.calls.map((call) => Number(call.query.pagina)), [1, 2]);
  assert.ok(fixture.calls.every((call) => Number(call.query.limite) === 2));
  assert.ok(fixture.calls.every((call) => call.metadata.operation === 'products.initial-sync'));
  assert.equal(fixture.values.has('BLING_PRODUCTS_SYNC_CHECKPOINT'), false);
  assert.equal(JSON.parse(fixture.values.get('BLING_LAST_PRODUCTS_SYNC_RUN')).recordsFetched, 3);
  assert.doesNotMatch(JSON.stringify([result, fixture.logs, [...fixture.values]]), /1101|1102|1103|SKU-/);
});

test('coleta de produtos retoma a página e não avança após falha de persistência', async () => {
  const fixture = createProductsSyncContext({
    pages: {
      1: { data: [{ id: 2101 }, { id: 2102 }] },
      2: { data: [{ id: 2103 }] }
    },
    maxPagesPerRun: 1
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/ProductsSyncJob.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/ProductsSyncJob.gs' }
  );

  const first = vm.runInContext('PRAProductsSyncJob.run({})', fixture.context);
  assert.equal(first.status, 'in_progress');
  assert.equal(first.nextPage, 2);
  fixture.store.shouldFail = true;
  const failed = vm.runInContext('PRAProductsSyncJob.run({})', fixture.context);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'page_persistence_failed');
  assert.equal(failed.nextPage, 2);
  assert.equal(JSON.parse(fixture.values.get('BLING_PRODUCTS_SYNC_CHECKPOINT')).nextPage, 2);

  fixture.store.shouldFail = false;
  const resumed = vm.runInContext('PRAProductsSyncJob.run({})', fixture.context);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.recordsFetched, 3);
  assert.deepEqual(fixture.calls.map((call) => Number(call.query.pagina)), [1, 2, 2]);
});

test('coleta de produtos bloqueia no limite seguro sem retornar falso sucesso', async () => {
  const fixture = createProductsSyncContext({
    pages: { 1: { data: [{ id: 2201 }, { id: 2202 }] } },
    maxPages: 1,
    maxPagesPerRun: 2
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/ProductsSyncJob.gs'), 'utf8'),
    fixture.context,
    { filename: 'src/jobs/ProductsSyncJob.gs' }
  );

  const result = vm.runInContext('PRAProductsSyncJob.run({})', fixture.context);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'page_limit_reached');
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.nextPage, 2);
});

test('armazenamento de produtos mantém pai, filho e produto simples sem duplicação', async () => {
  const spreadsheet = new FakeSpreadsheet();
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'spreadsheet-test'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    Array,
    JSON
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/SheetWriter.gs'), 'utf8'),
    context,
    { filename: 'src/core/SheetWriter.gs' }
  );
  vm.runInContext(
    await readFile(path.join(root, 'src/repositories/ProductStore.gs'), 'utf8'),
    context,
    { filename: 'src/repositories/ProductStore.gs' }
  );

  const first = vm.runInContext(`PRAProductStore.persistPage([
    { id: 3101, idProdutoPai: 0, codigo: 'SKU-PAI', nome: 'Pai', formato: 'V' },
    { id: 3102, idProdutoPai: 3101, codigo: 'SKU-FILHO-A', nome: 'Filho', formato: 'S' },
    { id: 3103, idProdutoPai: 0, codigo: 'SKU-SIMPLES', nome: 'Simples', formato: 'S' }
  ], { runId: 'products-a' })`, context);
  assert.equal(first.productsStored, 3);
  assert.equal(first.parentLinksStored, 1);

  vm.runInContext(`PRAProductStore.persistPage([
    { id: 3102, idProdutoPai: 3101, codigo: 'SKU-FILHO-B', nome: 'Filho atualizado', formato: 'S' }
  ], { runId: 'products-b' })`, context);

  const rows = spreadsheet.getSheetByName('raw_products').rows;
  assert.equal(rows.length, 4);
  const child = rows.find((row) => String(row[0]) === '3102');
  assert.equal(String(child[1]), '3101');
  assert.equal(child[2], 'SKU-FILHO-B');
  assert.equal(child[10], true);
  assert.equal(child[12], 'products-b');

  const standalone = vm.runInContext('PRAProductStore.findById(3103)', context);
  assert.equal(String(standalone.product_id), '3103');
  assert.equal(standalone.parent_product_id, '');
  assert.equal(standalone.sku, 'SKU-SIMPLES');
  assert.equal(standalone.is_variation, false);
});
