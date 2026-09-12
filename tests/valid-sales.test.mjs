import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

function spreadsheetMock() {
  const sheets = new Map();
  function range(sheet, row, col, rows, cols) {
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
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) {
      const sheet = {
        values: [],
        getLastRow() {
          let last = 0;
          this.values.forEach((values, index) => {
            if (values.some((cell) => cell !== '' && cell !== null)) last = index + 1;
          });
          return last;
        },
        getRange(row, col, rows, cols) { return range(this, row, col, rows, cols); },
        setFrozenRows() {}
      };
      sheets.set(name, sheet);
      return sheet;
    }
  };
}

async function fixture(attendedStatusId = '91002001') {
  const spreadsheet = spreadsheetMock();
  const logs = [];
  let uuid = 0;
  const values = new Map([
    ['BLING_STATUS_ATENDIDO_ID', attendedStatusId],
    ['DATA_SPREADSHEET_ID', 'sheet-id']
  ]);
  const context = vm.createContext({
    PRAConfig: {
      KEYS: {
        BLING_STATUS_ATENDIDO_ID: 'BLING_STATUS_ATENDIDO_ID',
        DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID'
      },
      requirePublicValue(key) {
        const value = values.get(key);
        if (!value) throw new Error(`Configuração obrigatória ausente: ${key}`);
        return value;
      }
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => `validity-run-${++uuid}` },
    PRALogger: { info: (event, metadata) => logs.push({ event, metadata }) },
    Date,
    Number,
    Object,
    String,
    Boolean,
    JSON,
    Array,
    Math
  });

  for (const file of ['src/repositories/DataLayerSchema.gs', 'src/services/ValidSalesService.gs']) {
    vm.runInContext(await readFile(path.join(root, file), 'utf8'), context, { filename: file });
  }

  const definition = context.PRADataLayerSchema.getBySheet('stg_orders');
  const sheet = spreadsheet.insertSheet('stg_orders');
  sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);

  return { context, spreadsheet, sheet, definition, logs, values };
}

function orderRow(definition, { orderId, statusId, valid = '' }) {
  const row = Array(definition.headers.length).fill('');
  row[definition.headers.indexOf('order_id')] = String(orderId);
  row[definition.headers.indexOf('order_number')] = `N-${orderId}`;
  row[definition.headers.indexOf('order_date')] = '2026-09-11';
  row[definition.headers.indexOf('status_id')] = String(statusId ?? '');
  row[definition.headers.indexOf('is_valid_sale')] = valid;
  row[definition.headers.indexOf('processed_at')] = '2026-09-11T10:00:00.000Z';
  row[definition.headers.indexOf('run_id')] = 'transform-run';
  return row;
}

test('classifica venda válida somente pelo ID técnico de Atendido', async () => {
  const f = await fixture();
  f.sheet.getRange(2, 1, 3, f.definition.headers.length).setValues([
    orderRow(f.definition, { orderId: 101, statusId: '91002001' }),
    orderRow(f.definition, { orderId: 102, statusId: '94001002' }),
    orderRow(f.definition, { orderId: 103, statusId: '' })
  ]);

  const result = f.context.PRAValidSalesService.run();
  assert.equal(result.ordersEvaluated, 3);
  assert.equal(result.validOrders, 1);
  assert.equal(result.excludedOrders, 2);

  const validIndex = f.definition.headers.indexOf('is_valid_sale');
  assert.deepEqual(
    f.sheet.values.slice(1).map((row) => row[validIndex]),
    [true, false, false]
  );
});

test('pedido que sai de Atendido deixa de ser válido na reclassificação', async () => {
  const f = await fixture();
  const statusIndex = f.definition.headers.indexOf('status_id');
  const validIndex = f.definition.headers.indexOf('is_valid_sale');
  f.sheet.getRange(2, 1, 1, f.definition.headers.length).setValues([
    orderRow(f.definition, { orderId: 201, statusId: '91002001' })
  ]);

  const first = f.context.PRAValidSalesService.run();
  assert.equal(first.validOrders, 1);
  assert.equal(f.sheet.values[1][validIndex], true);

  f.sheet.values[1][statusIndex] = '94001002';
  const second = f.context.PRAValidSalesService.run();
  assert.equal(second.validOrders, 0);
  assert.equal(second.excludedOrders, 1);
  assert.equal(f.sheet.values[1][validIndex], false);
});

test('pedido que passa para Atendido torna-se válido na execução seguinte', async () => {
  const f = await fixture();
  const statusIndex = f.definition.headers.indexOf('status_id');
  const validIndex = f.definition.headers.indexOf('is_valid_sale');
  f.sheet.getRange(2, 1, 1, f.definition.headers.length).setValues([
    orderRow(f.definition, { orderId: 301, statusId: '94001002', valid: false })
  ]);

  f.context.PRAValidSalesService.run();
  assert.equal(f.sheet.values[1][validIndex], false);
  f.sheet.values[1][statusIndex] = '91002001';
  f.context.PRAValidSalesService.run();
  assert.equal(f.sheet.values[1][validIndex], true);
});

test('configuração ausente ou inválida bloqueia classificação antes de alterar staging', async () => {
  const missing = await fixture('');
  missing.sheet.getRange(2, 1, 1, missing.definition.headers.length).setValues([
    orderRow(missing.definition, { orderId: 401, statusId: '91002001' })
  ]);
  assert.throws(() => missing.context.PRAValidSalesService.run(), /BLING_STATUS_ATENDIDO_ID|Configuração obrigatória/);
  assert.equal(missing.sheet.values[1][missing.definition.headers.indexOf('is_valid_sale')], '');

  const invalid = await fixture('Atendido');
  invalid.sheet.getRange(2, 1, 1, invalid.definition.headers.length).setValues([
    orderRow(invalid.definition, { orderId: 402, statusId: '91002001' })
  ]);
  assert.throws(() => invalid.context.PRAValidSalesService.run(), /ID técnico positivo/);
});

test('logs expõem apenas contagens e metadados técnicos', async () => {
  const f = await fixture();
  f.sheet.getRange(2, 1, 1, f.definition.headers.length).setValues([
    orderRow(f.definition, { orderId: 999999, statusId: '91002001' })
  ]);
  const result = f.context.PRAValidSalesService.run();
  const publicOutput = JSON.stringify([result, f.logs]);
  assert.doesNotMatch(publicOutput, /999999|91002001/);
  assert.match(publicOutput, /validOrders/);
});
