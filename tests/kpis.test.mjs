import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

async function loadKpis() {
  const context = vm.createContext({
    Date, Number, Object, String, Boolean, JSON, Array, Math, isNaN
  });
  const file = 'src/services/KpiService.gs';
  vm.runInContext(await readFile(path.join(root, file), 'utf8'), context, { filename: file });
  return context;
}

function normalized(value) {
  return JSON.parse(JSON.stringify(value));
}

test('faturamento por item usa desconto percentual e arredonda por linha', async () => {
  const context = await loadKpis();
  assert.equal(context.PRAKpiService.calculateItemRevenue(2, 75.25, 10), 135.45);
  assert.equal(context.PRAKpiService.calculateItemRevenue(3, 19.99, 5), 56.97);
  assert.equal(context.PRAKpiService.calculateItemRevenue(1, 20, 100), 0);
});

test('quantidade negativa reduz faturamento para suportar devoluções identificáveis', async () => {
  const context = await loadKpis();
  assert.equal(context.PRAKpiService.calculateItemRevenue(-1, 20, 10), -18);
});

test('entradas monetárias inválidas são rejeitadas sem ajuste silencioso', async () => {
  const context = await loadKpis();
  assert.throws(
    () => context.PRAKpiService.calculateItemRevenue(1, 20, 101),
    /percentual entre 0 e 100/
  );
  assert.throws(
    () => context.PRAKpiService.calculateItemRevenue(1, -20, 0),
    /não pode ser negativo/
  );
  assert.throws(
    () => context.PRAKpiService.calculateItemRevenue('', 20, 0),
    /obrigatório ausente/
  );
});

test('KPIs consideram somente vendas válidas e nunca somam frete', async () => {
  const context = await loadKpis();
  const result = normalized(context.PRAKpiService.calculateMetrics([
    { order_id: '101', order_date: '2026-09-01', is_valid_sale: true, freight: 9999 },
    { order_id: '102', order_date: '2026-09-02', is_valid_sale: 'TRUE', freight: 9999 },
    { order_id: '103', order_date: '2026-09-03', is_valid_sale: false, freight: 9999 }
  ], [
    { order_id: '101', quantity: 2, unit_value: 10, discount: 10 },
    { order_id: '102', quantity: -1, unit_value: 5, discount: 0 },
    { order_id: '103', quantity: 100, unit_value: 100, discount: 0 }
  ], '2026-09-01', '2026-09-30'));

  assert.deepEqual(result, {
    validOrders: 2,
    includedItems: 2,
    itemsQuantity: 1,
    revenue: 13,
    averageTicket: 6.5
  });
});

test('janela de KPI é inclusiva e usa a data do pedido', async () => {
  const context = await loadKpis();
  const orders = [
    { order_id: '1', order_date: '2026-08-31', is_valid_sale: true },
    { order_id: '2', order_date: '2026-09-01', is_valid_sale: true },
    { order_id: '3', order_date: '2026-09-30', is_valid_sale: true },
    { order_id: '4', order_date: '2026-10-01', is_valid_sale: true }
  ];
  const items = orders.map((order) => ({
    order_id: order.order_id, quantity: 1, unit_value: 10, discount: 0
  }));
  const result = normalized(
    context.PRAKpiService.calculateMetrics(orders, items, '2026-09-01', '2026-09-30')
  );

  assert.equal(result.validOrders, 2);
  assert.equal(result.itemsQuantity, 2);
  assert.equal(result.revenue, 20);
  assert.equal(result.averageTicket, 10);
});

test('ticket médio vazio é zero e janela invertida é rejeitada', async () => {
  const context = await loadKpis();
  const empty = normalized(context.PRAKpiService.calculateMetrics([], [], '', ''));
  assert.deepEqual(empty, {
    validOrders: 0,
    includedItems: 0,
    itemsQuantity: 0,
    revenue: 0,
    averageTicket: 0
  });
  assert.throws(
    () => context.PRAKpiService.calculateMetrics([], [], '2026-09-30', '2026-09-01'),
    /não pode ser posterior/
  );
});

test('pipeline analítico executa normalização antes da regra de venda válida', async () => {
  const calls = [];
  const context = vm.createContext({
    PRATransformService: {
      run(options) {
        calls.push(['transform', options.marker]);
        return {
          ok: true,
          status: 'completed',
          code: 'orders_normalization_completed',
          runId: 'normalization-run',
          ordersRead: 3,
          ordersStaged: 3,
          itemsRead: 4,
          itemsStaged: 4,
          itemRevenueCalculated: 4,
          itemRevenueErrors: 0,
          qualityErrors: 0,
          processedAt: '2026-09-12T10:00:00.000Z'
        };
      }
    },
    PRAValidSalesService: {
      run() {
        calls.push(['valid-sales']);
        return {
          ok: true, status: 'completed', code: 'valid_sales_classified',
          validOrders: 2, excludedOrders: 1
        };
      }
    },
    Number, Object, String, Boolean
  });
  const file = 'src/services/OrdersAnalyticsPipeline.gs';
  vm.runInContext(await readFile(path.join(root, file), 'utf8'), context, { filename: file });

  const result = normalized(context.PRAOrdersAnalyticsPipeline.run({ marker: 'shared-options' }));
  assert.deepEqual(calls, [['transform', 'shared-options'], ['valid-sales']]);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'orders_analytics_completed');
  assert.equal(result.itemRevenueCalculated, 4);
  assert.equal(result.validOrders, 2);
});

test('pipeline não classifica staging ainda não confirmado por orçamento', async () => {
  let validityCalls = 0;
  const context = vm.createContext({
    PRATransformService: {
      run: () => ({
        ok: true,
        status: 'in_progress',
        code: 'orders_normalization_budget_reached',
        itemsRead: 4,
        itemRevenueCalculated: 4
      })
    },
    PRAValidSalesService: { run: () => { validityCalls += 1; } },
    Number, Object, String, Boolean
  });
  const file = 'src/services/OrdersAnalyticsPipeline.gs';
  vm.runInContext(await readFile(path.join(root, file), 'utf8'), context, { filename: file });

  const result = normalized(context.PRAOrdersAnalyticsPipeline.run());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'in_progress');
  assert.equal(result.code, 'orders_normalization_budget_reached');
  assert.equal(validityCalls, 0);
});

test('pipeline bloqueia métricas incompletas antes da classificação comercial', async () => {
  let validityCalls = 0;
  const context = vm.createContext({
    PRATransformService: {
      run: () => ({
        ok: true,
        status: 'completed',
        code: 'orders_normalization_completed',
        itemRevenueCalculated: 3,
        itemRevenueErrors: 1
      })
    },
    PRAValidSalesService: { run: () => { validityCalls += 1; } },
    Number, Object, String, Boolean
  });
  const file = 'src/services/OrdersAnalyticsPipeline.gs';
  vm.runInContext(await readFile(path.join(root, file), 'utf8'), context, { filename: file });

  const result = normalized(context.PRAOrdersAnalyticsPipeline.run());
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'item_revenue_quality_blocked');
  assert.equal(validityCalls, 0);
});
