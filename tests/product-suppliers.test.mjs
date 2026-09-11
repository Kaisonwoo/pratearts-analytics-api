import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

function createSyncContext({ pages = {}, pageSize = 2, maxPages = 100, maxPagesPerRun = 10 } = {}) {
  const values = new Map([
    ['DATA_SPREADSHEET_ID', 'spreadsheet-test'],
    ['BLING_PRIMARY_SUPPLIER_RULE', 'marked_default']
  ]);
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
    shouldFailPersist: false,
    shouldFailFinalize: false,
    persistPage: (links, metadata) => {
      if (store.shouldFailPersist) throw new Error('storage unavailable');
      persisted.push({ links, metadata });
      return { linksStored: links.length, updatedAt: '2026-09-11T20:00:00.000Z' };
    },
    finalizeRun: (runId, rule) => {
      if (store.shouldFailFinalize) throw new Error('reconcile unavailable');
      return {
        linksStored: persisted.flatMap((entry) => entry.links).length,
        productsEvaluated: 4,
        productsWithoutSupplier: 1,
        productsWithSingleSupplier: 2,
        productsWithMultipleSuppliers: 1,
        primaryRule: rule,
        updatedAt: '2026-09-11T20:01:00.000Z',
        runId
      };
    }
  };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID',
        BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT: 'BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT',
        BLING_LAST_PRODUCT_SUPPLIERS_SYNC_RUN: 'BLING_LAST_PRODUCT_SUPPLIERS_SYNC_RUN',
        BLING_PRIMARY_SUPPLIER_RULE: 'BLING_PRIMARY_SUPPLIER_RULE'
      },
      DEFAULTS: { BLING_PRIMARY_SUPPLIER_RULE: 'marked_default' },
      getPublicValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      getRequestPolicy: () => ({ pageSize, maxPages, maxPagesPerRun })
    },
    PRABlingClient: {
      get: (requestPath, query, metadata) => {
        calls.push({ requestPath, query, metadata });
        const page = Number(query.pagina);
        const pageResult = pages[page];
        if (pageResult?.error) {
          return { ok: false, statusCode: pageResult.statusCode || 503, error: { code: pageResult.error } };
        }
        return { ok: true, statusCode: 200, data: pageResult ? pageResult.data : [] };
      }
    },
    PRAProductSupplierStore: store,
    PRALogger: {
      info: (event, metadata) => logs.push({ level: 'INFO', event, metadata }),
      warn: (event, metadata) => logs.push({ level: 'WARN', event, metadata }),
      error: (event, metadata) => logs.push({ level: 'ERROR', event, metadata })
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: { getUuid: () => `supplier-run-${++uuid}` },
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

async function loadJob(context) {
  vm.runInContext(
    await readFile(path.join(root, 'src/jobs/ProductSuppliersSyncJob.gs'), 'utf8'),
    context,
    { filename: 'src/jobs/ProductSuppliersSyncJob.gs' }
  );
}

test('coleta vínculos paginados e conclui com resumo seguro', async () => {
  const fixture = createSyncContext({
    pages: {
      1: { data: [
        { id: 7101, produto: { id: 8101 }, fornecedor: { id: 9101 } },
        { id: 7102, produto: { id: 8102 }, fornecedor: { id: 9102 } }
      ] },
      2: { data: [{ id: 7103, produto: { id: 8102 }, fornecedor: { id: 9103 } }] }
    }
  });
  await loadJob(fixture.context);

  const result = vm.runInContext('PRAProductSuppliersSyncJob.run({ reset: true })', fixture.context);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'product_suppliers_sync_completed');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.linksFetched, 3);
  assert.equal(result.productsWithMultipleSuppliers, 1);
  assert.deepEqual(fixture.calls.map((call) => call.requestPath), [
    '/produtos/fornecedores', '/produtos/fornecedores'
  ]);
  assert.ok(fixture.calls.every((call) => call.metadata.operation === 'product-suppliers.full-reconciliation'));
  assert.equal(fixture.values.has('BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT'), false);
  assert.equal(JSON.parse(fixture.values.get('BLING_LAST_PRODUCT_SUPPLIERS_SYNC_RUN')).linksFetched, 3);
  assert.doesNotMatch(JSON.stringify([result, fixture.logs, [...fixture.values]]), /7101|8101|9101/);
});

test('falha na reconciliação retoma a fase final sem refazer páginas', async () => {
  const fixture = createSyncContext({
    pages: { 1: { data: [{ id: 7201, produto: { id: 8201 }, fornecedor: { id: 9201 } }] } }
  });
  fixture.store.shouldFailFinalize = true;
  await loadJob(fixture.context);

  const failed = vm.runInContext('PRAProductSuppliersSyncJob.run({})', fixture.context);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'supplier_reconciliation_failed');
  assert.equal(fixture.calls.length, 1);
  assert.equal(JSON.parse(fixture.values.get('BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT')).phase, 'reconcile');

  fixture.store.shouldFailFinalize = false;
  const resumed = vm.runInContext('PRAProductSuppliersSyncJob.run({})', fixture.context);
  assert.equal(resumed.status, 'completed');
  assert.equal(fixture.calls.length, 1);
});

test('falha de persistência preserva página e permite nova tentativa', async () => {
  const fixture = createSyncContext({
    pages: { 1: { data: [
      { id: 7301, produto: { id: 8301 }, fornecedor: { id: 9301 } },
      { id: 7302, produto: { id: 8302 }, fornecedor: { id: 9302 } }
    ] } },
    maxPagesPerRun: 1
  });
  fixture.store.shouldFailPersist = true;
  await loadJob(fixture.context);

  const failed = vm.runInContext('PRAProductSuppliersSyncJob.run({})', fixture.context);
  assert.equal(failed.code, 'page_persistence_failed');
  assert.equal(failed.nextPage, 1);
  assert.equal(JSON.parse(fixture.values.get('BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT')).nextPage, 1);

  fixture.store.shouldFailPersist = false;
  const retried = vm.runInContext('PRAProductSuppliersSyncJob.run({})', fixture.context);
  assert.equal(retried.status, 'in_progress');
  assert.equal(retried.nextPage, 2);
  assert.deepEqual(fixture.calls.map((call) => Number(call.query.pagina)), [1, 1]);
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
    return this;
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }
  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

async function createStoreContext(productIds) {
  const spreadsheet = new FakeSpreadsheet();
  const products = spreadsheet.insertSheet('raw_products');
  products.rows = [['product_id'], ...productIds.map((id) => [String(id)])];
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'spreadsheet-test'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Date,
    Number,
    Object,
    String,
    Boolean,
    Array,
    JSON
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/repositories/ProductSupplierStore.gs'), 'utf8'),
    context,
    { filename: 'src/repositories/ProductSupplierStore.gs' }
  );
  return { context, spreadsheet };
}

function dataRows(sheet) {
  return sheet.rows.slice(1).filter((row) => row.some((cell) => cell !== '' && cell !== null));
}

test('reconciliação sinaliza produto sem, com um e com múltiplos fornecedores', async () => {
  const fixture = await createStoreContext([5101, 5102, 5103]);
  vm.runInContext(`PRAProductSupplierStore.persistPage([
    { id: 6101, produto: { id: 5101 }, fornecedor: { id: 7101 }, padrao: true },
    { id: 6102, produto: { id: 5102 }, fornecedor: { id: 7102 }, padrao: false },
    { id: 6103, produto: { id: 5102 }, fornecedor: { id: 7103 }, padrao: true }
  ], { runId: 'supplier-a' })`, fixture.context);

  const summary = vm.runInContext(
    `PRAProductSupplierStore.finalizeRun('supplier-a', 'marked_default')`,
    fixture.context
  );
  assert.equal(summary.productsEvaluated, 3);
  assert.equal(summary.productsWithoutSupplier, 1);
  assert.equal(summary.productsWithSingleSupplier, 1);
  assert.equal(summary.productsWithMultipleSuppliers, 1);

  const rows = dataRows(fixture.spreadsheet.getSheetByName('product_supplier_status'));
  const none = rows.find((row) => String(row[0]) === '5103');
  const single = rows.find((row) => String(row[0]) === '5101');
  const multiple = rows.find((row) => String(row[0]) === '5102');
  assert.equal(none[2], 'none');
  assert.equal(none[3], '');
  assert.equal(single[2], 'single');
  assert.equal(String(single[3]), '7101');
  assert.equal(multiple[2], 'multiple');
  assert.equal(Number(multiple[1]), 2);
  assert.equal(String(multiple[3]), '7103');
});

test('regra configurável pode escolher o menor preço de compra como principal', async () => {
  const fixture = await createStoreContext([5201]);
  vm.runInContext(`PRAProductSupplierStore.persistPage([
    { id: 6201, produto: { id: 5201 }, fornecedor: { id: 7201 }, precoCompra: 55, padrao: true },
    { id: 6202, produto: { id: 5201 }, fornecedor: { id: 7202 }, precoCompra: 40, padrao: false }
  ], { runId: 'supplier-b' })`, fixture.context);
  vm.runInContext(
    `PRAProductSupplierStore.finalizeRun('supplier-b', 'lowest_purchase_price')`,
    fixture.context
  );

  const row = dataRows(fixture.spreadsheet.getSheetByName('product_supplier_status'))[0];
  assert.equal(String(row[3]), '7202');
  assert.equal(String(row[4]), '6202');
  assert.equal(row[5], 'lowest_purchase_price');
});
