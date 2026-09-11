import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

function fixture(options = {}) {
  const values = new Map();
  if (options.initialEndDate !== null) {
    values.set('BLING_LAST_INITIAL_ORDERS_RUN', JSON.stringify({
      status: 'completed',
      endDate: options.initialEndDate || '2026-09-10'
    }));
  }
  values.set('BLING_INCREMENTAL_LOOKBACK_DAYS', String(options.lookbackDays ?? 1));

  const calls = [];
  const persisted = [];
  let failPersist = false;
  let uuid = 0;
  const pages = options.pages || {};

  const props = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };

  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_LAST_INITIAL_ORDERS_RUN: 'BLING_LAST_INITIAL_ORDERS_RUN',
        SYNC_TIMEZONE: 'SYNC_TIMEZONE'
      },
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
          return {
            ok: false,
            statusCode: 503,
            correlationId: 'corr-test',
            error: { code: response.error }
          };
        }
        return { ok: true, statusCode: 200, data: response.data };
      }
    },
    PRALogger: { info: () => {}, warn: () => {}, error: () => {} },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => `run-${++uuid}`,
      formatDate: () => '2026-09-11'
    },
    Date, Number, Object, String, Boolean, JSON, Array
  });

  context.persist = (orders, page, metadata) => {
    if (failPersist) throw new Error('storage unavailable');
    persisted.push({ orders, page, metadata });
  };

  return {
    context, values, calls, persisted,
    failPersist: (value) => { failPersist = value; }
  };
}

async function load(context, file = 'OrdersIncrementalSyncJob.gs') {
  const code = await readFile(path.join(root, 'src/jobs', file), 'utf8');
  vm.runInContext(code, context, { filename: `src/jobs/${file}` });
}

test('incremental usa margem e filtros de data de alteração', async () => {
  const f = fixture({
    pages: {
      1: { data: [{ id: 1 }, { id: 2 }] },
      2: { data: [{ id: 3 }] }
    }
  });
  await load(f.context);

  const result = vm.runInContext(
    "PRAOrdersIncrementalSync.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.baselineSource, 'initial_load');
  assert.equal(result.windowStart, '2026-09-09');
  assert.equal(result.windowEnd, '2026-09-11');
  assert.equal(result.recordsFetched, 3);
  assert.deepEqual(f.calls.map((call) => Number(call.query.pagina)), [1, 2]);
  assert.ok(f.calls.every((call) => call.query.dataAlteracaoInicial === '2026-09-09'));
  assert.ok(f.calls.every((call) => call.query.dataAlteracaoFinal === '2026-09-11'));
  assert.ok(f.calls.every((call) => call.metadata.operation === 'sales-orders.incremental'));
  assert.equal(f.values.has('BLING_INCREMENTAL_ORDERS_CHECKPOINT'), false);
  assert.equal(JSON.parse(f.values.get('BLING_LAST_INCREMENTAL_ORDERS_RUN')).windowEnd, '2026-09-11');
});

test('falha de persistência não avança a página', async () => {
  const f = fixture({
    pages: { 1: { data: [{ id: 4 }, { id: 5 }] } },
    maxPagesPerRun: 1
  });
  await load(f.context);
  f.failPersist(true);

  const failed = vm.runInContext(
    "PRAOrdersIncrementalSync.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(failed.code, 'page_persistence_failed');
  assert.equal(JSON.parse(f.values.get('BLING_INCREMENTAL_ORDERS_CHECKPOINT')).nextPage, 1);

  f.failPersist(false);
  const retried = vm.runInContext(
    "PRAOrdersIncrementalSync.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(retried.status, 'in_progress');
  assert.equal(retried.nextPage, 2);
  assert.deepEqual(f.calls.map((call) => Number(call.query.pagina)), [1, 1]);
});

test('retomada mantém a janela original mesmo em outro dia', async () => {
  const f = fixture({ pages: { 2: { data: [{ id: 6 }] } } });
  f.values.set('BLING_INCREMENTAL_ORDERS_CHECKPOINT', JSON.stringify({
    runId: 'existing-run',
    baselineSource: 'incremental',
    baselineDate: '2026-09-09',
    windowStart: '2026-09-08',
    windowEnd: '2026-09-10',
    lookbackDays: 1,
    pageSize: 2,
    nextPage: 2,
    pagesFetched: 1,
    recordsFetched: 2,
    startedAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:01:00.000Z'
  }));
  await load(f.context);

  const result = vm.runInContext(
    "PRAOrdersIncrementalSync.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.windowEnd, '2026-09-10');
  assert.equal(f.calls[0].query.pagina, 2);
  assert.equal(f.calls[0].query.dataAlteracaoFinal, '2026-09-10');
});

test('sem carga inicial concluída não consulta a API', async () => {
  const f = fixture({ initialEndDate: null });
  await load(f.context);

  const result = vm.runInContext(
    "PRAOrdersIncrementalSync.run({ today: '2026-09-11', onPage: persist })",
    f.context
  );
  assert.equal(result.code, 'incremental_baseline_missing');
  assert.equal(f.calls.length, 0);
});

test('DailySync delega ao incremental e enfileira detalhes', async () => {
  const queued = [];
  const context = vm.createContext({
    PRAOrdersIncrementalSync: {
      run: (options) => {
        options.onPage([{ id: 7 }], 2, { runId: 'daily-run' });
        return { ok: true, status: 'completed', code: 'incremental_sync_completed' };
      }
    },
    PRAOrderDetailsQueue: {
      enqueuePage: (orders, page, metadata) => queued.push({ orders, page, metadata })
    },
    PRALogger: { info: () => {} },
    Boolean
  });
  await load(context, 'DailySyncJob.gs');

  const result = vm.runInContext("PRADailySyncJob.run({ today: '2026-09-11' })", context);
  assert.equal(result.status, 'completed');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].page, 2);
  assert.equal(queued[0].metadata.runId, 'daily-run');
});
