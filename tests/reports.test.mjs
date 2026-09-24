import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const copy = value => JSON.parse(JSON.stringify(value));

const headers = {
  mart_period_state: ['period_key','source_hash','output_hash','calculated_at','run_id'],
  mart_kpis: ['period_key','period_start','period_end','valid_orders','items_quantity','revenue','average_ticket','calculated_at','run_id'],
  mart_product_sales: ['mart_key','period_key','product_id','parent_product_id','sku','supplier_id','quantity','revenue','orders_count','calculated_at','run_id'],
  stg_products: ['product_id','parent_product_id','analysis_product_id','sku','name','is_variation','source_updated_at','processed_at','run_id'],
  data_quality_errors: ['error_key','entity_type','entity_key','error_code','severity','detected_at','resolved_at','run_id'],
  recalc_windows: ['recalc_key','window_start','window_end','reason','status','marked_at','run_id'],
  sync_runs: ['run_id','job_name','status','started_at','finished_at','duration_ms','pages_processed','records_processed','error_code','correlation_id']
};

function makeSheet(name, objects) {
  const rows = [headers[name], ...objects.map(object => headers[name].map(key => object[key] ?? ''))];
  return {
    getLastRow: () => rows.length,
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues: () => Array.from({ length: rowCount }, (_, rowIndex) =>
          Array.from({ length: columnCount }, (_, columnIndex) =>
            rows[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''))
      };
    }
  };
}

async function fixture(options = {}) {
  let locked = false;
  const logs = [];
  const sheets = new Map();
  const seed = (name, rows) => sheets.set(name, makeSheet(name, rows));
  seed('mart_period_state', [
    { period_key: '2026-09-10', calculated_at: '2026-09-14T12:30:00Z' },
    { period_key: '2026-09-11', calculated_at: '2026-09-14T12:36:00Z' }
  ]);
  seed('mart_kpis', [
    { period_key: '2026-09-10', valid_orders: 2, items_quantity: 4, revenue: 20, average_ticket: 10 },
    { period_key: '2026-09-11', valid_orders: 1, items_quantity: 1, revenue: 5, average_ticket: 5 },
    { period_key: '2026-09-12', valid_orders: 99, items_quantity: 99, revenue: 999, average_ticket: 10 }
  ]);
  seed('mart_product_sales', [
    { mart_key: 'product:1', period_key: '2026-09-10', product_id: '101', sku: 'SYN-A', supplier_id: '901', quantity: 2, revenue: 15, orders_count: 1 },
    { mart_key: 'product:2', period_key: '2026-09-10', product_id: '102', sku: 'SYN-B', supplier_id: '902', quantity: 2, revenue: 5, orders_count: 1 },
    { mart_key: 'parent:1', period_key: '2026-09-10', product_id: '100', supplier_id: '901', quantity: 4, revenue: 20, orders_count: 2 },
    { mart_key: 'product:3', period_key: '2026-09-11', product_id: '101', sku: 'SYN-A', supplier_id: '901', quantity: 1, revenue: 5, orders_count: 1 },
    { mart_key: 'parent:2', period_key: '2026-09-11', product_id: '100', supplier_id: '901', quantity: 1, revenue: 5, orders_count: 1 }
  ]);
  seed('stg_products', [
    { product_id: '100', sku: 'SYN-P', name: 'Família sintética' },
    { product_id: '101', parent_product_id: '100', sku: 'SYN-A', name: 'Produto sintético A', is_variation: true },
    { product_id: '102', parent_product_id: '100', sku: 'SYN-B', name: 'Produto sintético B', is_variation: false }
  ]);
  seed('data_quality_errors', [
    { error_key: 'q1', error_code: 'invalid_supplier_id', severity: 'warning', detected_at: '2026-09-10T00:00:00Z' },
    { error_key: 'q2', error_code: 'invalid_supplier_id', severity: 'warning', detected_at: '2026-09-10T00:00:00Z', resolved_at: '2026-09-11T00:00:00Z' }
  ]);
  seed('recalc_windows', [{ recalc_key: 'w1', status: 'completed' }]);
  seed('sync_runs', [{
    run_id: 'r1', job_name: 'daily', status: 'completed',
    started_at: '2026-09-14T11:00:00Z', finished_at: '2026-09-14T11:01:00Z',
    duration_ms: 60000, records_processed: 3
  }]);

  const context = vm.createContext({
    Date,
    Number,
    console,
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'synthetic-sheet'
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: name => sheets.get(name) })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => options.busy ? false : (locked = true),
        releaseLock: () => { locked = false; }
      })
    },
    ScriptApp: {
      getProjectTriggers: () => [{ getHandlerFunction: () => 'runDailySync' }]
    },
    PRALogger: { warn: (event, metadata) => logs.push({ event, metadata }) },
    PRA_RUNTIME_METADATA: { revision: 'synthetic-revision', sourceHash: 'abc123' }
  });
  vm.runInContext(await readFile('src/repositories/DataLayerSchema.gs', 'utf8'), context);
  vm.runInContext(await readFile('src/services/ReportService.gs', 'utf8'), context);
  vm.runInContext(await readFile('src/services/ReportCsvService.gs', 'utf8'), context);
  return { context, logs, locked: () => locked };
}

test('relatórios: envelope agrega apenas períodos confirmados e uma visão', async () => {
  const fixtureValue = await fixture();
  const result = copy(fixtureValue.context.PRAReportService.execute({}));
  assert.deepEqual(Object.keys(result), ['data', 'meta', 'filtersApplied', 'errors']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    [result.data.kpis.validOrders, result.data.kpis.itemsQuantity, result.data.kpis.revenue, result.data.kpis.averageTicket],
    [3, 5, 25, 8.33]
  );
  assert.equal(result.data.trend.length, 2);
  assert.deepEqual(result.data.rankings.map(row => [row.productId, row.revenue]), [['101', 20], ['102', 5]]);
  assert.equal(result.meta.coverage.confirmedPeriods, 2);
  assert.equal(result.meta.runtime.revision, 'synthetic-revision');
  assert.equal(result.data.quality.unresolvedErrors, 1);
  assert.equal(result.data.operations.triggers.installed, 1);
  assert.equal(fixtureValue.locked(), false);
  assert.ok(!JSON.stringify(result).includes('entity_key'));
  assert.ok(!JSON.stringify(result).includes('correlation_id'));
});

test('relatórios: visão de família e fornecedor são aplicados antes da agregação', async () => {
  const fixtureValue = await fixture();
  const result = copy(fixtureValue.context.PRAReportService.execute({
    startDate: '2026-09-10',
    endDate: '2026-09-11',
    view: 'parent',
    supplierId: '901',
    limit: 5
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.rankings.length, 1);
  assert.equal(result.data.rankings[0].productId, '100');
  assert.equal(result.data.rankings[0].revenue, 25);
  assert.equal(result.filtersApplied.view, 'parent');
});

test('recursos especializados leem somente períodos confirmados e uma visão de vendas', async () => {
  const { context } = await fixture();
  const query = resource => copy(context.PRAReportService.executeResource(resource, {}));
  const kpis = query('kpis');
  const trend = query('trend');
  const products = query('products');
  const variations = query('variations');
  const suppliers = query('suppliers');

  assert.deepEqual(kpis.errors, []);
  assert.equal(kpis.data.kpis.revenue, 25);
  assert.deepEqual(Object.keys(kpis.filtersApplied), ['startDate', 'endDate']);
  assert.equal(trend.data.trend.length, 2);
  assert.deepEqual(products.data.products.map(row => row.revenue), [20, 5]);
  assert.deepEqual(variations.data.variations.map(row => row.productId), ['101']);
  assert.deepEqual(suppliers.data.suppliers.map(row => [row.supplierId, row.revenue, row.knownProductsCount]),
    [['901', 20, 1], ['902', 5, 1]]);
  assert.equal(suppliers.data.suppliers.reduce((sum, row) => sum + row.revenue, 0), 25);
  assert.ok(!JSON.stringify(suppliers).includes('ordersCount'));
});

test('recursos especializados recusam filtros que mudariam o significado dos totais', async () => {
  const { context } = await fixture();
  const run = (resource, filters) => copy(context.PRAReportService.executeResource(resource, filters));
  assert.equal(run('kpis', { supplierId: '901' }).errors[0].code, 'report_filter_unsupported');
  assert.equal(run('trend', { supplierId: '901' }).errors[0].code, 'report_filter_unsupported');
  assert.equal(run('kpis', { view: 'parent' }).errors[0].code, 'report_filter_unsupported');
  assert.equal(run('trend', { limit: '1' }).errors[0].code, 'report_filter_unsupported');
  assert.equal(run('variations', { view: 'parent' }).errors[0].code, 'report_invalid_view');
  assert.equal(run('suppliers', { view: 'parent' }).errors[0].code, 'report_invalid_view');
  assert.equal(run('kpis', { startDate: '2026-09-10malicious' }).errors[0].code,
    'report_invalid_start_date');
  assert.deepEqual(run('suppliers', { supplierId: '902' }).data.suppliers.map(row => row.supplierId), ['902']);
});

test('CSV exporta somente agregados confirmados e neutraliza fórmulas em texto', async () => {
  const { context } = await fixture();
  const trend = copy(context.PRAReportService.executeResource('trend', {}));
  const csv = context.PRAReportCsvService.serialize('trend', trend.data);
  assert.ok(csv.startsWith('\uFEFF"period","valid_orders","items_quantity","revenue","average_ticket"\r\n'));
  assert.equal(csv.trim().split('\r\n').length, 3);
  assert.doesNotMatch(csv, /999/);

  const products = context.PRAReportCsvService.serialize('products', {
    products: [{
      position: 1, view: 'product', productId: '101', sku: '-SYN-A', supplierId: '901',
      name: '=HYPERLINK("x", "y")\nOutra linha', quantity: -2, revenue: -3, ordersCount: 1
    }]
  });
  assert.match(products, /"\t=HYPERLINK\(""x"", ""y""\) Outra linha"/);
  assert.match(products, /"\t-SYN-A"/);
  assert.match(products, /,-2,-3,1\r\n$/);
  assert.equal(products.trim().split('\r\n').length, 2);
});

test('relatórios: validações retornam códigos estáveis sem detalhes internos', async () => {
  const fixtureValue = await fixture();
  const invalid = copy(fixtureValue.context.PRAReportService.execute({
    startDate: '2026-09-12',
    endDate: '2026-09-10'
  }));
  assert.equal(invalid.data, null);
  assert.equal(invalid.errors[0].code, 'report_invalid_date_range');
  assert.deepEqual(Object.keys(invalid), ['data', 'meta', 'filtersApplied', 'errors']);
  assert.ok(!JSON.stringify(invalid).includes('synthetic-sheet'));
});

test('relatórios: lock ocupado retorna indisponibilidade temporária', async () => {
  const fixtureValue = await fixture({ busy: true });
  const result = copy(fixtureValue.context.PRAReportService.execute({}));
  assert.equal(result.errors[0].code, 'report_source_busy');
  assert.equal(result.data, null);
});

test('web app preserva saúde legada e roteia HTML e envelopes novos', async () => {
  const context = vm.createContext({
    Date,
    JSON,
    PRAOAuthService: {},
    PRAHealthService: { getStatus: () => ({ status: 'ok' }) },
    PRAReportService: {
      execute: filters => ({ data: { filters }, meta: {}, filtersApplied: filters, errors: [] }),
      executeResource: (resource, filters) => ({
        data: { resource }, meta: {}, filtersApplied: filters, errors: []
      }),
      errorEnvelope: (code, message) => ({ data: null, meta: {}, filtersApplied: {}, errors: [{ code, message }] })
    },
    PRAReportCsvService: { serialize: resource => `header\r\n${resource}\r\n` },
    HtmlService: {
      createHtmlOutput: value => ({ value, setTitle() { return this; } }),
      createHtmlOutputFromFile: file => ({
        type: 'html', file,
        setTitle() { return this; },
        addMetaTag() { return this; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'json', CSV: 'csv' },
      createTextOutput: value => ({
        value, mime: null, fileName: null,
        setMimeType(mime) { this.mime = mime; return this; },
        downloadAsFile(fileName) { this.fileName = fileName; return this; }
      })
    }
  });
  vm.runInContext(await readFile('src/api/WebApp.gs', 'utf8'), context);
  assert.equal(context.doGet({ parameter: { view: 'dashboard' } }).file, 'Index');
  const dashboard = JSON.parse(context.doGet({ parameter: { resource: 'dashboard' } }).value);
  assert.deepEqual(Object.keys(dashboard), ['data', 'meta', 'filtersApplied', 'errors']);
  const suppliers = JSON.parse(context.doGet({ parameter: { resource: 'suppliers' } }).value);
  assert.equal(suppliers.data.resource, 'suppliers');
  const csv = context.doGet({ parameter: { resource: 'suppliers', format: 'csv' } });
  assert.equal(csv.mime, 'csv');
  assert.equal(csv.fileName, 'pratearts-suppliers.csv');
  assert.equal(csv.value, 'header\r\nsuppliers\r\n');
  assert.equal(context.doGet({ parameter: { resource: 'products', view: 'parent', format: 'csv' } }).mime,
    'csv');
  assert.equal(JSON.parse(context.doGet({ parameter: { resource: 'dashboard', format: 'csv' } }).value)
    .errors[0].code, 'report_export_unsupported');
  assert.equal(JSON.parse(context.doGet({ parameter: { resource: 'missing', format: 'csv' } }).value)
    .errors[0].code, 'report_unknown_resource');
  assert.equal(JSON.parse(context.doGet({ parameter: { resource: 'products', format: 'xlsx' } }).value)
    .errors[0].code, 'report_invalid_format');
  const unknown = JSON.parse(context.doGet({ parameter: { resource: 'missing' } }).value);
  assert.equal(unknown.errors[0].code, 'report_unknown_resource');
  assert.deepEqual(JSON.parse(context.doGet({ parameter: {} }).value), { status: 'ok' });
});

test('CSV aplica validação real dos filtros antes de produzir o arquivo', async () => {
  const { context } = await fixture();
  context.ContentService = {
    MimeType: { JSON: 'json', CSV: 'csv' },
    createTextOutput(value) {
      return {
        value, mime: null,
        setMimeType(mime) { this.mime = mime; return this; },
        downloadAsFile() { return this; }
      };
    }
  };
  vm.runInContext(await readFile('src/api/WebApp.gs', 'utf8'), context);
  const invalid = context.doGet({ parameter: {
    resource: 'products', view: 'dashboard', format: 'csv'
  } });
  assert.equal(invalid.mime, 'json');
  assert.equal(JSON.parse(invalid.value).errors[0].code, 'report_invalid_view');

  const valid = context.doGet({ parameter: {
    resource: 'products', view: 'parent', format: 'csv'
  } });
  assert.equal(valid.mime, 'csv');
  assert.match(valid.value, /"parent","100"/);
});

test('HTML usa somente o bridge do contrato e possui estados acessíveis', async () => {
  const html = await readFile('src/ui/Index.html', 'utf8');
  assert.match(html, /google\.script\.run/);
  assert.match(html, /getDashboardSnapshot/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /fornecedor filtra apenas o ranking/i);
  assert.match(html, /dados sintéticos/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /SpreadsheetApp|openById/);
});
