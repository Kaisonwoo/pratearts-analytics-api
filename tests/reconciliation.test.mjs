import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

async function load(context, file) {
  if (file === 'src/jobs/OrdersReconciliationJob.gs') {
    const lease = await readFile(path.join(root, 'src/core/ExecutionLease.gs'), 'utf8');
    vm.runInContext(lease, context, { filename: 'src/core/ExecutionLease.gs' });
    const budget = await readFile(path.join(root, 'src/core/RuntimeBudget.gs'), 'utf8');
    vm.runInContext(budget, context, { filename: 'src/core/RuntimeBudget.gs' });
  }
  if (file === 'src/repositories/RecalculationWindowStore.gs') {
    const writer = await readFile(path.join(root, 'src/core/SheetWriter.gs'), 'utf8');
    vm.runInContext(writer, context, { filename: 'src/core/SheetWriter.gs' });
  }
  const code = await readFile(path.join(root, file), 'utf8');
  vm.runInContext(code, context, { filename: file });
}

function jobFixture(options = {}) {
  const values = new Map();
  values.set('BLING_RECONCILIATION_WINDOW_DAYS', String(options.windowDays ?? 30));
  values.set('BLING_RECONCILIATION_FREQUENCY_DAYS', String(options.frequencyDays ?? 7));
  if (options.lastRun) {
    values.set('BLING_LAST_RECONCILIATION_RUN', JSON.stringify(options.lastRun));
  }
  if (options.checkpoint) {
    values.set('BLING_RECONCILIATION_CHECKPOINT', JSON.stringify(options.checkpoint));
  }

  const calls = [];
  const persisted = [];
  const markers = [];
  let failPersist = false;
  let failMarker = false;
  let uuid = 0;
  const pages = options.pages || {};

  const props = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };

  const context = vm.createContext({
    PRAConfig: {
      KEYS: { SYNC_TIMEZONE: 'SYNC_TIMEZONE' },
      DEFAULTS: { SYNC_TIMEZONE: 'America/Sao_Paulo' },
      getPublicValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      getRequestPolicy: () => ({
        pageSize: options.pageSize || 2,
        maxPages: 100,
        maxPagesPerRun: options.maxPagesPerRun || 10
      })
    },
    PRABlingClient: {
      get: (requestPath, query, metadata) => {
        calls.push({ requestPath, query, metadata });
        const response = pages[Number(query.pagina)] || { data: [] };
        if (response.error) {
          return { ok: false, statusCode: 503, correlationId: 'corr-r', error: { code: response.error } };
        }
        return { ok: true, statusCode: 200, correlationId: 'corr-r', data: response.data };
      }
    },
    PRARecalculationWindowStore: {
      stageWindow: (start, end, reason, runId) => {
        if (failMarker) throw new Error('marker unavailable');
        markers.push({ start, end, reason, runId });
        return { ok: true, status: 'waiting_details' };
      }
    },
    PRALogger: { info() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => `reconciliation-${++uuid}`,
      formatDate: () => '2026-09-11'
    },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    Math
  });
  context.persist = (orders, page, metadata) => {
    if (failPersist) throw new Error('queue unavailable');
    persisted.push({ orders, page, metadata });
  };

  return {
    context, values, calls, persisted, markers,
    failPersist(value) { failPersist = value; },
    failMarker(value) { failMarker = value; }
  };
}

test('reconciliação usa janela configurável e aguarda detalhes do intervalo afetado', async () => {
  const f = jobFixture({
    windowDays: 5,
    frequencyDays: 3,
    pages: {
      1: { data: [{ id: 10 }, { id: 11 }] },
      2: { data: [{ id: 12 }] }
    }
  });
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');

  const result = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.windowStart, '2026-09-07');
  assert.equal(result.windowEnd, '2026-09-11');
  assert.equal(result.recordsFetched, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.map((call) => call.query))), [
    { dataInicial: '2026-09-07', dataFinal: '2026-09-11', pagina: 1, limite: 2 },
    { dataInicial: '2026-09-07', dataFinal: '2026-09-11', pagina: 2, limite: 2 }
  ]);
  assert.ok(f.calls.every((call) => call.metadata.operation === 'sales-orders.historical-reconciliation'));
  assert.equal(f.markers.length, 1);
  assert.equal(f.markers[0].reason, 'historical_reconciliation');
  assert.equal(f.persisted[0].metadata.reconciliation, true);
  assert.equal(f.values.has('BLING_RECONCILIATION_CHECKPOINT'), false);
});

test('reconciliação respeita frequência mínima sem consultar API', async () => {
  const f = jobFixture({
    frequencyDays: 7,
    lastRun: { status: 'completed', windowEnd: '2026-09-08' }
  });
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');

  const result = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(result.status, 'skipped');
  assert.equal(result.code, 'reconciliation_not_due');
  assert.equal(result.nextEligibleDate, '2026-09-15');
  assert.equal(f.calls.length, 0);
});

test('checkpoint incompleto é retomado mesmo antes da próxima frequência', async () => {
  const checkpoint = {
    runId: 'resume-run', phase: 'fetch', windowStart: '2026-08-13', windowEnd: '2026-09-11',
    windowDays: 30, frequencyDays: 7, pageSize: 2, nextPage: 2,
    pagesFetched: 1, recordsFetched: 2, startedAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T10:01:00.000Z'
  };
  const f = jobFixture({
    checkpoint,
    lastRun: { status: 'completed', windowEnd: '2026-09-10' },
    pages: { 2: { data: [{ id: 20 }] } }
  });
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');

  const result = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-12', onPage: persist })",
    f.context
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, 'resume-run');
  assert.equal(result.windowEnd, '2026-09-11');
  assert.equal(f.calls[0].query.pagina, 2);
  assert.equal(f.calls[0].query.dataFinal, '2026-09-11');
});

test('falha no enfileiramento preserva a mesma página', async () => {
  const f = jobFixture({ pages: { 1: { data: [{ id: 30 }, { id: 31 }] } }, maxPagesPerRun: 1 });
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');
  f.failPersist(true);

  const failed = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(failed.code, 'page_persistence_failed');
  assert.equal(JSON.parse(f.values.get('BLING_RECONCILIATION_CHECKPOINT')).nextPage, 1);

  f.failPersist(false);
  const retried = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(retried.status, 'in_progress');
  assert.equal(retried.nextPage, 2);
  assert.deepEqual(f.calls.map((call) => call.query.pagina), [1, 1]);
});

test('reconciliação salva checkpoint ao atingir orçamento de tempo', async () => {
  const f = jobFixture({ pages: { 1: { data: [{ id: 33 }] } } });
  let clock = 0;
  f.context.Date = class extends Date {
    static now() { clock += 1000; return clock; }
  };
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');

  const result = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', maxRuntimeMs: 1000, reserveMs: 0, onPage: persist })",
    f.context
  );
  assert.equal(result.status, 'in_progress');
  assert.equal(result.code, 'execution_budget_reached');
  assert.equal(result.nextPage, 1);
  assert.equal(f.calls.length, 0);
});

test('falha ao preparar recálculo retoma somente a fase final', async () => {
  const f = jobFixture({ pages: { 1: { data: [{ id: 40 }] } } });
  await load(f.context, 'src/jobs/OrdersReconciliationJob.gs');
  f.failMarker(true);

  const failed = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(failed.code, 'recalc_stage_failed');
  assert.equal(JSON.parse(f.values.get('BLING_RECONCILIATION_CHECKPOINT')).phase, 'mark');
  assert.equal(f.calls.length, 1);

  f.failMarker(false);
  const retried = vm.runInContext(
    "PRAOrdersReconciliationJob.run({ today: '2026-09-12', onPage: persist })",
    f.context
  );
  assert.equal(retried.status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.markers.length, 1);
});

function spreadsheetMock() {
  const sheets = new Map();
  function createRange(sheet, row, col, rows, cols) {
    return {
      setValues(input) {
        input.forEach((sourceRow, r) => {
          const target = row - 1 + r;
          if (!sheet.values[target]) sheet.values[target] = [];
          sourceRow.forEach((value, c) => { sheet.values[target][col - 1 + c] = value; });
        });
        return this;
      },
      getValues() {
        return Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => sheet.values[row - 1 + r]?.[col - 1 + c] ?? '')
        );
      },
      clearContent() {
        for (let r = row - 1; r < row - 1 + rows; r += 1) {
          if (!sheet.values[r]) continue;
          for (let c = col - 1; c < col - 1 + cols; c += 1) sheet.values[r][c] = '';
        }
        return this;
      }
    };
  }
  return {
    sheets,
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      const sheet = {
        values: [], frozenRows: 0,
        getLastRow() {
          let last = 0;
          this.values.forEach((row, index) => {
            if (row.some((cell) => cell !== '' && cell !== null)) last = index + 1;
          });
          return last;
        },
        getRange(row, col, rows, cols) { return createRange(this, row, col, rows, cols); },
        setFrozenRows(value) { this.frozenRows = value; }
      };
      sheets.set(name, sheet);
      return sheet;
    }
  };
}

test('marcador de recálculo é idempotente para a mesma janela e motivo', async () => {
  const spreadsheet = spreadsheetMock();
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-id'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Date,
    Object,
    String,
    JSON,
    Math
  });
  await load(context, 'src/repositories/RecalculationWindowStore.gs');

  context.PRARecalculationWindowStore.markWindow('2026-09-01', '2026-09-11', 'historical_reconciliation', 'run-a');
  context.PRARecalculationWindowStore.markWindow('2026-09-01', '2026-09-11', 'historical_reconciliation', 'run-b');

  const sheet = spreadsheet.sheets.get('recalc_windows');
  assert.equal(sheet.getLastRow(), 2);
  assert.equal(sheet.values[1][0], '2026-09-01:2026-09-11:historical_reconciliation');
  assert.equal(sheet.values[1][4], 'pending');
  assert.equal(sheet.values[1][6], 'run-b');
});

test('janela só muda de waiting_details para pending após ativação explícita', async () => {
  const spreadsheet = spreadsheetMock();
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-id'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Date, Object, String, JSON, Math, Number, Array
  });
  await load(context, 'src/repositories/RecalculationWindowStore.gs');

  context.PRARecalculationWindowStore.stageWindow(
    '2026-09-01', '2026-09-11', 'historical_reconciliation', 'run-stage'
  );
  const sheet = spreadsheet.sheets.get('recalc_windows');
  assert.equal(sheet.values[1][4], 'waiting_details');

  const result = context.PRARecalculationWindowStore.activateWaitingWindows();
  assert.equal(result.activated, 1);
  assert.equal(sheet.values[1][4], 'pending');
});
