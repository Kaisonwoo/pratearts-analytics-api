import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

function spreadsheetMock() {
  const sheets = new Map();

  function createRange(sheet, row, col, rows, cols) {
    return {
      setValues(input) {
        if (sheet.failNextSetValues > 0) {
          sheet.failNextSetValues -= 1;
          throw new Error('synthetic setValues failure');
        }
        input.forEach((sourceRow, r) => {
          const targetRow = row - 1 + r;
          if (!sheet.values[targetRow]) sheet.values[targetRow] = [];
          sourceRow.forEach((value, c) => {
            sheet.values[targetRow][col - 1 + c] = value;
          });
        });
        return this;
      },
      getValues() {
        return Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) =>
            sheet.values[row - 1 + r]?.[col - 1 + c] ?? ''
          )
        );
      },
      clearContent() {
        for (let r = row - 1; r < row - 1 + rows; r += 1) {
          if (!sheet.values[r]) continue;
          for (let c = col - 1; c < col - 1 + cols; c += 1) {
            sheet.values[r][c] = '';
          }
        }
        return this;
      }
    };
  }

  return {
    sheets,
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) {
      const sheet = {
        values: [],
        failNextSetValues: 0,
        frozenRows: 0,
        getLastRow() {
          let last = 0;
          this.values.forEach((values, index) => {
            if (values.some((cell) => cell !== '' && cell !== null)) last = index + 1;
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

async function createFixture() {
  const spreadsheet = spreadsheetMock();
  const logs = [];
  let uuid = 0;
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-id'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => `transform-run-${++uuid}` },
    PRALogger: { info: (event, metadata) => logs.push({ event, metadata }) },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    Math,
    isNaN
  });

  for (const file of [
    'src/repositories/DataLayerSchema.gs',
    'src/core/RuntimeBudget.gs',
    'src/core/SheetWriter.gs',
    'src/services/TransformService.gs'
  ]) {
    const code = await readFile(path.join(root, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  function seed(name, rows) {
    const definition = context.PRADataLayerSchema.getBySheet(name);
    const sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    if (rows.length) sheet.getRange(2, 1, rows.length, definition.headers.length).setValues(rows);
    return sheet;
  }

  return { context, spreadsheet, logs, seed };
}

function normalized(value) {
  return JSON.parse(JSON.stringify(value));
}

function validOrder(overrides = {}) {
  const values = {
    order_id: '101',
    order_number: 5001,
    store_order_number: '',
    order_date: '2026-09-10T14:00:00-03:00',
    departure_date: '',
    expected_date: '',
    status_id: '9',
    store_id: '',
    category_id: '',
    seller_id: '',
    products_total: '150.50',
    order_total: '160.50',
    other_expenses: 0,
    freight: '10',
    discount_value: '',
    discount_unit: 'REAL',
    updated_at: '2026-09-11T10:00:00Z',
    run_id: 'raw-run'
  };
  Object.assign(values, overrides);
  return [
    values.order_id, values.order_number, values.store_order_number, values.order_date,
    values.departure_date, values.expected_date, values.status_id, values.store_id,
    values.category_id, values.seller_id, values.products_total, values.order_total,
    values.other_expenses, values.freight, values.discount_value, values.discount_unit,
    values.updated_at, values.run_id
  ];
}

function validItem(overrides = {}) {
  const values = {
    item_key: '101:1',
    order_id: '101',
    item_id: '1',
    product_id: '900',
    sku: ' SKU-1 ',
    unit: 'UN',
    quantity: '2',
    unit_value: '75.25',
    discount: '',
    source_position: 1,
    updated_at: '2026-09-11T10:00:00Z',
    run_id: 'raw-run'
  };
  Object.assign(values, overrides);
  return [
    values.item_key, values.order_id, values.item_id, values.product_id,
    values.sku, values.unit, values.quantity, values.unit_value,
    values.discount, values.source_position, values.updated_at, values.run_id
  ];
}

test('TransformService normaliza tipos, datas e chaves estáveis', async () => {
  const f = await createFixture();
  f.seed('raw_orders', [validOrder()]);
  f.seed('raw_order_items', [validItem()]);

  const result = f.context.PRATransformService.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.ordersStaged, 1);
  assert.equal(result.itemsStaged, 1);
  assert.equal(result.qualityErrors, 0);

  const stgOrders = f.spreadsheet.sheets.get('stg_orders');
  const stgItems = f.spreadsheet.sheets.get('stg_order_items');
  const order = normalized(stgOrders.values[1]);
  const item = normalized(stgItems.values[1]);

  assert.equal(order[0], '101');
  assert.equal(order[1], '5001');
  assert.equal(order[2], '2026-09-10');
  assert.equal(order[3], '9');
  assert.equal(order[4], 150.5);
  assert.equal(order[5], 160.5);
  assert.equal(order[6], 10);
  assert.equal(order[7], 0);
  assert.equal(order[8], '');
  assert.equal(order[9], '2026-09-11T10:00:00.000Z');
  assert.equal(order[11], result.runId);

  assert.equal(item[0], '101:1');
  assert.equal(item[1], '101');
  assert.equal(item[2], '900');
  assert.equal(item[3], 'SKU-1');
  assert.equal(item[4], 2);
  assert.equal(item[5], 75.25);
  assert.equal(item[6], 0);
  assert.equal(item[7], '');
  assert.equal(item[8], '2026-09-11T10:00:00.000Z');
  assert.equal(item[10], result.runId);
});

test('chaves obrigatórias ausentes impedem staging e geram exceções', async () => {
  const f = await createFixture();
  f.seed('raw_orders', [
    validOrder(),
    validOrder({ order_id: '', order_number: 5002 })
  ]);
  f.seed('raw_order_items', [
    validItem(),
    validItem({ item_key: '', item_id: '2' }),
    validItem({ item_key: '999:1', order_id: '999', product_id: '', sku: '' })
  ]);

  const result = f.context.PRATransformService.run();
  assert.equal(result.ordersRead, 2);
  assert.equal(result.ordersStaged, 1);
  assert.equal(result.itemsRead, 3);
  assert.equal(result.itemsStaged, 2);
  assert.ok(result.qualityErrors >= 5);

  const quality = f.spreadsheet.sheets.get('data_quality_errors').values.slice(1);
  const codes = quality.map((row) => row[3]);
  assert.ok(codes.includes('missing_order_id'));
  assert.ok(codes.includes('missing_item_key'));
  assert.ok(codes.includes('orphan_order'));
  assert.ok(codes.includes('missing_product_id'));
  assert.ok(codes.includes('missing_sku'));
});

test('campos inválidos são neutralizados e registrados sem derrubar a execução', async () => {
  const f = await createFixture();
  f.seed('raw_orders', [validOrder({ order_date: '2026-99-99', status_id: 'abc', order_total: 'x' })]);
  f.seed('raw_order_items', [validItem({ quantity: 'x', updated_at: 'not-a-date' })]);

  const result = f.context.PRATransformService.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.ordersStaged, 1);
  assert.equal(result.itemsStaged, 1);

  const order = normalized(f.spreadsheet.sheets.get('stg_orders').values[1]);
  const item = normalized(f.spreadsheet.sheets.get('stg_order_items').values[1]);
  assert.equal(order[2], '');
  assert.equal(order[3], '');
  assert.equal(order[5], 0);
  assert.equal(item[4], 0);
  assert.equal(item[8], '');

  const codes = f.spreadsheet.sheets.get('data_quality_errors').values.slice(1).map((row) => row[3]);
  assert.ok(codes.includes('invalid_order_date'));
  assert.ok(codes.includes('invalid_status_id'));
  assert.ok(codes.includes('invalid_order_total'));
  assert.ok(codes.includes('invalid_quantity'));
  assert.ok(codes.includes('invalid_source_updated_at'));
});

test('nova execução é idempotente e resolve exceção que deixou de existir', async () => {
  const f = await createFixture();
  const rawOrders = f.seed('raw_orders', [validOrder({ order_date: 'invalid' })]);
  f.seed('raw_order_items', [validItem()]);

  const first = f.context.PRATransformService.run();
  assert.ok(first.qualityErrors >= 1);
  assert.equal(f.spreadsheet.sheets.get('stg_orders').getLastRow(), 2);
  assert.equal(f.spreadsheet.sheets.get('stg_order_items').getLastRow(), 2);

  rawOrders.values[1][3] = '2026-09-10';
  const second = f.context.PRATransformService.run();
  assert.equal(second.ordersStaged, 1);
  assert.equal(second.itemsStaged, 1);
  assert.equal(f.spreadsheet.sheets.get('stg_orders').getLastRow(), 2);
  assert.equal(f.spreadsheet.sheets.get('stg_order_items').getLastRow(), 2);

  const qualityRows = f.spreadsheet.sheets.get('data_quality_errors').values.slice(1);
  const previousError = qualityRows.find((row) => row[3] === 'invalid_order_date');
  assert.ok(previousError);
  assert.ok(previousError[6]);
  assert.equal(previousError[7], second.runId);
});

test('preserva erros externos e não expõe valores comerciais no resumo ou log', async () => {
  const f = await createFixture();
  f.seed('raw_orders', [validOrder({ order_number: 'ORDER-SECRET', order_total: 9876.54 })]);
  f.seed('raw_order_items', [validItem({ sku: 'SKU-SECRET' })]);
  const qualityDefinition = f.context.PRADataLayerSchema.getBySheet('data_quality_errors');
  const qualitySheet = f.spreadsheet.insertSheet('data_quality_errors');
  qualitySheet.getRange(1, 1, 1, qualityDefinition.headers.length).setValues([qualityDefinition.headers]);
  qualitySheet.getRange(2, 1, 1, qualityDefinition.headers.length).setValues([[
    'external:test', 'product', '900', 'external_issue', 'warning',
    '2026-09-01T00:00:00.000Z', '', 'external-run'
  ]]);

  const result = f.context.PRATransformService.run();
  const qualityRows = f.spreadsheet.sheets.get('data_quality_errors').values.slice(1);
  assert.ok(qualityRows.some((row) => row[0] === 'external:test'));

  const publicOutput = JSON.stringify([result, f.logs]);
  assert.doesNotMatch(publicOutput, /ORDER-SECRET|SKU-SECRET|9876\.54/);
  assert.match(publicOutput, /orders_normalization_completed/);
});

test('falha entre abas restaura integralmente o ultimo staging valido', async () => {
  const f = await createFixture();
  f.seed('raw_orders', [validOrder({ order_id: '202', order_number: 9002 })]);
  f.seed('raw_order_items', [validItem({ item_key: '202:1', order_id: '202' })]);

  const oldOrder = Array(12).fill('old-order');
  const oldItem = Array(11).fill('old-item');
  const oldQuality = [
    'external:old', 'order', '101', 'old_issue', 'warning',
    '2026-09-01T00:00:00.000Z', '', 'old-run'
  ];
  const stgOrders = f.seed('stg_orders', [oldOrder]);
  const stgItems = f.seed('stg_order_items', [oldItem]);
  const quality = f.seed('data_quality_errors', [oldQuality]);
  stgItems.failNextSetValues = 1;

  assert.throws(
    () => f.context.PRATransformService.run(),
    /base anterior foi restaurada/
  );
  assert.deepEqual(normalized(stgOrders.values[1]), oldOrder);
  assert.deepEqual(normalized(stgItems.values[1]), oldItem);
  assert.deepEqual(normalized(quality.values[1]), oldQuality);
});
