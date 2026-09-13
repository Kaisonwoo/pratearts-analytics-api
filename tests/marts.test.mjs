import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const copy = value => JSON.parse(JSON.stringify(value));
const stamp = '2026-09-12T00:00:00.000Z';
async function realScheduler(f) {
  const triggers = [];
  let fail = false;
  f.context.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) };
  f.context.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: handler => ({ timeBased() { return this; }, after() { return this; }, create() {
      if (fail) throw new Error('PRIVATE synthetic trigger failure');
      triggers.push({ getHandlerFunction: () => handler });
    } }),
    deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1)
  };
  vm.runInContext(await readFile('src/core/ContinuationScheduler.gs', 'utf8'), f.context);
  return { triggers, failCreation: () => { fail = true; } };
}
async function fixture() {
  const sheets = new Map(), props = new Map(), logs = [], scheduled = new Set();
  let writes = 0, busy = false, now = 1000000, uuid = 0;
  function sheet(name) {
    const s = { rows: [], fail: 0, maxRows: 1000, expansionFail: false, setFrozenRows() {},
      getMaxRows() { return this.maxRows; },
      insertRowsAfter(after, count) {
        if (this.expansionFail) throw new Error('synthetic capacity failure');
        assert.equal(after, this.maxRows); this.maxRows += count;
      },
      getLastRow() {
        return this.rows.reduce((last, row, i) => row.some(v => v !== '' && v != null) ? i + 1 : last, 0);
      },
      getRange(row, col, rows, cols) {
        if (row + rows - 1 > s.maxRows) throw new Error('range exceeds grid');
        return {
          getValues: () => Array.from({ length: rows }, (_, r) =>
            Array.from({ length: cols }, (_, c) => s.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
          setValues(values) {
            if (s.fail-- > 0) throw new Error('synthetic failure with PRIVATE payload');
            writes++;
            values.forEach((valuesRow, r) => {
              s.rows[row - 1 + r] ??= [];
              valuesRow.forEach((v, c) => { s.rows[row - 1 + r][col - 1 + c] = v; });
            });
          },
          clearContent() {
            writes++;
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              if (s.rows[row - 1 + r]) s.rows[row - 1 + r][col - 1 + c] = '';
            }
          }
        };
      }
    };
    sheets.set(name, s); return s;
  }
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock,
    PRAConfig: { KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID', BLING_STATUS_ATENDIDO_ID: 'BLING_STATUS_ATENDIDO_ID' },
      requirePublicValue: key => key === 'BLING_STATUS_ATENDIDO_ID' ? '9' : 'synthetic-sheet', getRequestPolicy: () => ({}) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets.get(name), insertSheet: sheet }), flush() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => !busy, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) ?? null }) },
    Utilities: { getUuid: () => `synthetic-run-${++uuid}`, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, data) => Array.from(createHash(algorithm).update(data).digest()) },
    PRAContinuationScheduler: {
      schedule: name => { scheduled.add(name); return { scheduled: true }; },
      cancel: name => { scheduled.delete(name); return { scheduled: false }; }
    },
    PRALogger: { info: (event, metadata) => logs.push({ event, metadata: copy(metadata) }) }
  });
  for (const file of ['src/repositories/DataLayerSchema.gs', 'src/core/SheetWriter.gs',
    'src/core/RuntimeBudget.gs', 'src/services/KpiService.gs', 'src/services/MartService.gs', 'src/jobs/MartsJob.gs']) {
    vm.runInContext(await readFile(file, 'utf8'), context, { filename: file });
  }
  const schema = name => Array.from(context.PRADataLayerSchema.getBySheet(name).headers);
  function seed(name, objects) {
    const s = sheets.get(name) || sheet(name);
    s.rows = [schema(name), ...objects.map(o => schema(name).map(key => o[key] ?? ''))];
    s.maxRows = Math.max(s.maxRows, s.rows.length); return s;
  }
  function read(name) {
    return sheets.get(name).rows.slice(1).filter(row => row.some(v => v !== '' && v != null))
      .map(row => Object.fromEntries(schema(name).map((key, i) => [key, row[i]])));
  }
  for (const def of context.PRADataLayerSchema.list()) seed(def.sheet, []);
  function orders(objects) {
    seed('raw_orders', objects.map(o => ({ ...o, updated_at: stamp })));
    seed('stg_orders', objects.map(o => ({ ...o, is_valid_sale: o.status_id === '9', source_updated_at: stamp })));
  }
  function items(objects) {
    seed('raw_order_items', objects.map(o => ({ ...o, updated_at: stamp })));
    seed('stg_order_items', objects.map(o => ({ ...o, source_updated_at: stamp,
      item_revenue: context.PRAKpiService.calculateItemRevenue(o.quantity, o.unit_value, o.discount) })));
  }
  const baseOrders = [
    { order_id: '1', order_date: '2026-09-10', status_id: '9' },
    { order_id: '2', order_date: '2026-09-10', status_id: '9' },
    { order_id: '3', order_date: '2026-09-10', status_id: '6' },
    { order_id: '4', order_date: '2026-09-11', status_id: '9' }
  ];
  const baseItems = [
    { item_key: '1:1', order_id: '1', product_id: '101', sku: 'SYN-A', quantity: 2, unit_value: 10, discount: 10 },
    { item_key: '1:2', order_id: '1', product_id: '102', sku: 'SYN-B', quantity: 3, unit_value: 4, discount: 0 },
    { item_key: '2:1', order_id: '2', product_id: '101', sku: 'SYN-A', quantity: -1, unit_value: 10, discount: 0 },
    { item_key: '3:1', order_id: '3', product_id: '101', sku: 'SYN-A', quantity: 100, unit_value: 10, discount: 0 },
    { item_key: '4:1', order_id: '4', product_id: '103', sku: 'SYN-C', quantity: 1, unit_value: 5, discount: 0 }
  ];
  orders(baseOrders); items(baseItems);
  seed('raw_products', [
    { product_id: '100', sku: 'SYN-P', updated_at: stamp },
    { product_id: '101', parent_product_id: '100', sku: 'SYN-A', updated_at: stamp },
    { product_id: '102', parent_product_id: '100', sku: 'SYN-B', updated_at: stamp },
    { product_id: '103', sku: 'SYN-C', updated_at: stamp }
  ]);
  seed('stg_product_suppliers', [
    { product_id: '101', supplier_id: '901', link_state: 'single' },
    { product_id: '102', supplier_id: '901', link_state: 'multiple' },
    { product_id: '103', supplier_id: '', link_state: 'none' }
  ]);
  const run = options => copy(context.PRAMartsJob.run({ scheduleContinuation: false, ...options }));
  return { context, sheets, props, logs, scheduled, seed, read, orders, items, baseOrders, baseItems, run,
    writes: () => writes, busy: value => { busy = value; }, advance: value => { now += value; } };
}

test('marts: agendador real retoma o lote, deduplica e cancela somente seu gatilho', async () => {
  const f = await fixture(); const scheduler = await realScheduler(f);
  f.context.PRAContinuationScheduler.schedule('runDailySyncContinuation', 60000);
  const first = f.run({ scheduleContinuation: true, maxPeriodsPerRun: 1 });
  assert.equal(first.status, 'in_progress');
  assert.equal(first.periodsWritten, 1);
  assert.equal(first.continuationScheduled, true);
  assert.equal(f.context.PRAContinuationScheduler.schedule('runMartsContinuation', 60000).existing, true);
  assert.equal(scheduler.triggers.length, 2);
  const resumed = f.run({ scheduleContinuation: true, maxPeriodsPerRun: 1, replaceContinuation: true });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.periodsWritten, 1);
  assert.deepEqual(scheduler.triggers.map(t => t.getHandlerFunction()), ['runDailySyncContinuation']);
  assert.equal(f.run({ scheduleContinuation: true }).periodsWritten, 0);
  assert.throws(() => f.context.PRAContinuationScheduler.schedule('unknownHandler', 60000));
});

test('marts: falha do gatilho mantém progresso persistido e retoma sem duplicação', async () => {
  const f = await fixture(); const scheduler = await realScheduler(f); scheduler.failCreation();
  const failed = f.run({ scheduleContinuation: true, maxPeriodsPerRun: 1 });
  assert.equal(failed.code, 'mart_continuation_failed');
  assert.equal(failed.periodsWritten, 1);
  assert.equal(failed.periodsRemaining, 1);
  assert.equal(f.read('mart_period_state').length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE'));
  const resumed = f.run({ scheduleContinuation: true });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.periodsWritten, 1);
  assert.equal(f.read('mart_period_state').length, 2);
});

test('marts: KPI diário, devolução, desconto e pedidos distintos por família', async () => {
  const f = await fixture(); const r = f.run();
  assert.equal(r.status, 'completed'); assert.equal(r.periodsWritten, 2);
  const kpi = f.read('mart_kpis')[0];
  assert.deepEqual([kpi.valid_orders, kpi.items_quantity, kpi.revenue, kpi.average_ticket], [2, 4, 20, 10]);
  const sales = f.read('mart_product_sales');
  const parent = sales.find(row => row.mart_key.startsWith('parent:') && row.product_id === '100');
  assert.deepEqual([parent.quantity, parent.revenue, parent.orders_count], [4, 20, 2]);
  assert.equal(sales.filter(row => row.mart_key.startsWith('product:')).reduce((s, row) => s + row.revenue, 0), 25);
  assert.equal(sales.filter(row => row.mart_key.startsWith('parent:')).reduce((s, row) => s + row.revenue, 0), 25);
  assert.equal(r.missingSupplierItems, 1); assert.equal(r.multipleSupplierItems, 1);
  assert.equal(f.read('stg_products').find(p => p.product_id === '103').analysis_product_id, '103');
});

test('marts: repetição não grava nem altera períodos confirmados', async () => {
  const f = await fixture(); f.run(); const snapshot = copy(f.read('mart_kpis')); const writes = f.writes();
  const r = f.run(); assert.equal(r.periodsWritten, 0); assert.equal(f.writes(), writes);
  assert.deepEqual(f.read('mart_kpis'), snapshot);
});

test('marts: catálogo maior que a grade inicial amplia staging antes da gravação', async () => {
  const f = await fixture();
  f.seed('raw_products', Array.from({ length: 1200 }, (_, i) => ({
    product_id: String(i + 1), sku: `SYN-${i}`, updated_at: stamp
  })));
  assert.equal(f.run().status, 'completed');
  assert.equal(f.read('stg_products').length, 1200);
  assert.equal(f.sheets.get('stg_products').maxRows, 1201);
});

test('marts: falha ao ampliar grade preserva os marts e deixa estado pendente', async () => {
  const f = await fixture(); f.run();
  const before = copy(f.read('mart_kpis'));
  f.seed('raw_products', Array.from({ length: 1200 }, (_, i) => ({
    product_id: String(i + 1), sku: `SYN-${i}`, updated_at: stamp
  })));
  f.sheets.get('stg_products').expansionFail = true;
  assert.equal(f.run().code, 'mart_storage_failed');
  assert.deepEqual(f.read('mart_kpis'), before);
  f.sheets.get('stg_products').expansionFail = false;
  assert.equal(f.run().status, 'completed');
});

test('marts: alteração de data corrige o dia antigo e o novo', async () => {
  const f = await fixture(); f.run();
  f.orders(f.baseOrders.map(o => ({ ...o, order_date: '2026-09-12' })));
  const r = f.run(); assert.equal(r.periodsWritten, 3);
  assert.deepEqual(f.read('mart_kpis').map(k => [k.period_key, k.revenue]), [
    ['2026-09-10', 0], ['2026-09-11', 0], ['2026-09-12', 25]
  ]);
  assert.ok(f.read('mart_product_sales').every(row => row.period_key === '2026-09-12'));
});

test('marts: cancelamento remove a venda e mantém período não afetado intacto', async () => {
  const f = await fixture(); f.run(); const previousDay = copy(f.read('mart_kpis')[1]);
  f.orders(f.baseOrders.map(o => o.order_id === '1' ? { ...o, status_id: '6' } : o));
  assert.equal(f.run().periodsWritten, 1);
  assert.deepEqual(f.read('mart_kpis')[1], previousDay);
  assert.equal(f.read('mart_kpis')[0].revenue, -10);
});

test('marts: janela só conclui após todos os lotes afetados', async () => {
  const f = await fixture(); f.run();
  f.seed('recalc_windows', [{ recalc_key: 'synthetic-window', window_start: '2026-09-10',
    window_end: '2026-09-11', reason: 'reconciliation', status: 'pending', marked_at: stamp, run_id: 'synthetic-recalc' }]);
  const first = f.run({ maxPeriodsPerRun: 1, scheduleContinuation: true });
  assert.equal(first.status, 'in_progress'); assert.equal(first.periodsRemaining, 1);
  assert.equal(f.read('recalc_windows')[0].status, 'pending');
  assert.equal(f.scheduled.size, 1);
  const second = f.run({ maxPeriodsPerRun: 1, scheduleContinuation: true, replaceContinuation: true });
  assert.equal(second.periodsWritten, 1); assert.equal(second.windowsCompleted, 1);
  assert.equal(f.read('recalc_windows')[0].status, 'completed'); assert.equal(f.scheduled.size, 0);
  assert.equal(f.run().periodsWritten, 0);
});

test('marts: falha na segunda aba restaura a primeira e não confirma estado', async () => {
  const f = await fixture(); f.run(); const before = copy(f.read('mart_kpis'));
  f.items(f.baseItems.map(i => ({ ...i, quantity: i.quantity * 2 })));
  f.sheets.get('mart_product_sales').fail = 1;
  const r = f.run(); assert.equal(r.code, 'sheet_write_failed_rolled_back');
  assert.deepEqual(f.read('mart_kpis'), before);
  assert.equal(f.run().status, 'completed'); assert.equal(f.read('mart_kpis')[0].revenue, 40);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE'));
});

test('marts: falha no checkpoint após gravação é reparada na retomada', async () => {
  const f = await fixture(); f.run();
  f.items(f.baseItems.map(i => ({ ...i, quantity: i.quantity * 2 })));
  f.sheets.get('mart_period_state').fail = 1;
  assert.equal(f.run().status, 'blocked');
  assert.equal(f.run().periodsWritten, 2); assert.equal(f.run().periodsWritten, 0);
});

test('marts: interrupção abrupta e corrupção da saída são detectadas pelo hash', async () => {
  const f = await fixture(); f.run();
  const old = f.read('mart_kpis'); f.seed('mart_kpis', old.map(o => ({ ...o, revenue: 9999 })));
  assert.equal(f.run().periodsWritten, 2);
  assert.equal(f.read('mart_kpis')[0].revenue, 20);
});

test('marts: fornecedor atual mudou e reatribui apenas dias com vendas daquele produto', async () => {
  const f = await fixture(); f.run();
  f.seed('stg_product_suppliers', f.read('stg_product_suppliers').map(s => s.product_id === '101' ? { ...s, supplier_id: '902' } : s));
  assert.equal(f.run().periodsWritten, 1);
  assert.ok(f.read('mart_product_sales').filter(r => r.product_id === '101').every(r => r.supplier_id === '902'));
});

test('marts: mudança de pai refaz a consolidação e preserva produtos sem pai', async () => {
  const f = await fixture(); f.run();
  f.seed('raw_products', f.read('raw_products').map(p => p.product_id === '102' ? { ...p, parent_product_id: '' } : p));
  assert.equal(f.run().periodsWritten, 1);
  assert.equal(f.read('mart_product_sales').find(r => r.product_id === '100').revenue, 8);
  assert.ok(f.read('mart_product_sales').some(r => r.mart_key.startsWith('parent:') && r.product_id === '102'));
});

test('marts: produtos de mesmo SKU e itens sem produto não somem ou se confundem', async () => {
  const f = await fixture();
  f.items(f.baseItems.map(i => ({ ...i, sku: 'SYN-SAME', product_id: i.order_id === '4' ? '' : i.product_id })));
  f.run();
  const sales = f.read('mart_product_sales').filter(r => r.mart_key.startsWith('product:'));
  assert.equal(sales.length, 3); assert.equal(sales.reduce((s, r) => s + r.revenue, 0), 25);
});

test('marts: staging mais antigo que raw bloqueia sem escrita', async () => {
  const f = await fixture();
  f.seed('raw_orders', f.read('raw_orders').map(o => ({ ...o, status_id: '6' })));
  assert.equal(f.run().code, 'mart_staging_outdated'); assert.equal(f.writes(), 0);
});

test('marts: classificação em branco, data inválida e duplicidade bloqueiam', async () => {
  for (const change of [
    rows => rows.map(o => ({ ...o, is_valid_sale: '' })),
    rows => rows.map(o => ({ ...o, order_date: '2026-02-30' })),
    rows => rows.concat(rows[0])
  ]) {
    const f = await fixture(); f.seed('stg_orders', change(f.read('stg_orders')));
    assert.equal(f.run().status, 'blocked'); assert.equal(f.writes(), 0);
  }
});

test('marts: receita ausente e divergente bloqueia, inclusive em venda excluída', async () => {
  for (const value of ['', 999]) {
    const f = await fixture(); f.seed('stg_order_items', f.read('stg_order_items').map(i => ({ ...i, item_revenue: value })));
    assert.equal(f.run().status, 'blocked'); assert.equal(f.writes(), 0);
  }
});

test('marts: checkpoint e fila pendentes nunca liberam agregação', async () => {
  for (const properties of [
    { BLING_PRODUCTS_SYNC_CHECKPOINT: '{}' },
    { BLING_ORDER_DETAILS_QUEUE_INDEX: JSON.stringify({ version: 1, shards: ['shard'] }), shard: JSON.stringify({ entries: [{ orderId: '1' }] }) },
    { BLING_ORDER_DETAILS_QUEUE_INDEX: 'invalid-json' }
  ]) {
    const f = await fixture(); Object.entries(properties).forEach(([key, value]) => f.props.set(key, value));
    assert.equal(f.run().status, 'blocked'); assert.equal(f.writes(), 0);
  }
});

test('marts: waiting_details e erro de detalhe bloqueiam sem afetar marts existentes', async () => {
  const f = await fixture(); f.run(); const before = f.writes();
  f.seed('recalc_windows', [{ recalc_key: 'window', window_start: '2026-09-10', window_end: '2026-09-11', status: 'waiting_details' }]);
  assert.equal(f.run().code, 'mart_upstream_pending'); assert.equal(f.writes(), before);
  f.seed('recalc_windows', []); f.seed('order_detail_errors', [{ order_id: '5' }]);
  assert.equal(f.run().code, 'mart_quality_blocked'); assert.equal(f.writes(), before);
});

test('marts: anomalias de fornecedor permanecem auditáveis sem bloquear itens válidos', async () => {
  const f = await fixture(); f.seed('data_quality_errors', [{ error_key: 'product_supplier_link:synthetic', severity: 'error' }]);
  assert.equal(f.run().status, 'completed'); assert.equal(f.read('data_quality_errors').length, 1);
});

test('marts: orçamento encerrado e lock ocupado agendam continuação sem escrita', async () => {
  const f = await fixture();
  const result = f.run({ deadlineAtMs: 1000001, scheduleContinuation: true });
  assert.equal(result.status, 'in_progress'); assert.equal(f.writes(), 0); assert.equal(f.scheduled.size, 1);
  f.busy(true); assert.equal(f.run({ scheduleContinuation: true }).code, 'mart_execution_busy');
  assert.equal(f.writes(), 0); assert.equal(f.scheduled.size, 1);
});

test('marts: cabeçalho incompatível bloqueia e não toca nos dados', async () => {
  const f = await fixture(); f.sheets.get('mart_product_sales').rows[0][0] = 'wrong';
  assert.equal(f.run().code, 'mart_schema_mismatch'); assert.equal(f.writes(), 0);
});

test('marts: vazio não inventa pedidos e encerra janela sem dados', async () => {
  const f = await fixture(); f.orders([]); f.items([]);
  f.seed('recalc_windows', [{ recalc_key: 'empty', window_start: '2026-09-01', window_end: '2026-09-02', status: 'pending' }]);
  assert.equal(f.run().windowsCompleted, 1); assert.equal(f.read('mart_kpis').length, 0);
});

test('marts: metadados de reprocessamento não provocam reconstrução diária', async () => {
  const f = await fixture(); f.run();
  f.seed('stg_orders', f.read('stg_orders').map(o => ({ ...o, processed_at: 'synthetic-new', run_id: 'synthetic-new' })));
  assert.equal(f.run().periodsWritten, 0);
  assert.ok(!JSON.stringify(f.logs).includes('SYN-A'));
  assert.ok(f.logs.every(log => !('revenue' in log.metadata)));
});
