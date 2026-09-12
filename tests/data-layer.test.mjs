import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load(file, context) {
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

function spreadsheetMock() {
  const sheets = new Map();

  function range(sheet, row, col, rows, cols) {
    return {
      setValues(values) {
        values.forEach((valuesRow, r) => {
          const target = row - 1 + r;
          if (!sheet.values[target]) sheet.values[target] = [];
          valuesRow.forEach((value, c) => {
            sheet.values[target][col - 1 + c] = value;
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
    getSheetByName(name) {
      return sheets.get(name) || null;
    },
    insertSheet(name) {
      const sheet = {
        name,
        values: [],
        frozenRows: 0,
        getLastRow() {
          let last = 0;
          this.values.forEach((valuesRow, index) => {
            if (valuesRow.some((cell) => cell !== '' && cell !== null)) last = index + 1;
          });
          return last;
        },
        getRange(row, col, rows, cols) {
          return range(this, row, col, rows, cols);
        },
        setFrozenRows(value) {
          this.frozenRows = value;
        }
      };
      sheets.set(name, sheet);
      return sheet;
    }
  };
}

test('schema cobre raw, staging, mart e logs com chaves documentadas', () => {
  const context = { Object };
  load('src/repositories/DataLayerSchema.gs', context);
  const definitions = context.PRADataLayerSchema.list();
  assert.deepEqual(
    Array.from(new Set(Array.from(definitions, (item) => item.layer))).sort(),
    ['logs', 'mart', 'raw', 'staging']
  );
  assert.ok(Array.from(definitions).every((item) =>
    item.sheet && item.key && Array.from(item.headers).includes(item.key)
  ));
  assert.equal(new Set(Array.from(definitions, (item) => item.sheet)).size, definitions.length);
});

test('provisionamento cria abas, registra metadados e é idempotente', () => {
  const spreadsheet = spreadsheetMock();
  const lock = { waitLock() {}, releaseLock() {} };
  const context = {
    Object,
    JSON,
    Math,
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-1'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => lock }
  };
  load('src/repositories/DataLayerSchema.gs', context);
  load('src/core/SheetWriter.gs', context);
  load('src/repositories/DataLayerProvisioner.gs', context);

  const first = context.PRADataLayerProvisioner.run();
  const second = context.PRADataLayerProvisioner.run();
  assert.equal(first.ok, true);
  assert.equal(first.sheetsCreated, first.sheetsVerified);
  assert.equal(second.sheetsCreated, 0);
  assert.equal(
    spreadsheet.sheets.get('_schema_registry').getLastRow(),
    first.metadataRows + 1
  );
});

test('provisionamento rejeita cabeçalho incompatível sem sobrescrever dados', () => {
  const spreadsheet = spreadsheetMock();
  const rawOrders = spreadsheet.insertSheet('raw_orders');
  rawOrders.getRange(1, 1, 1, 2).setValues([['wrong', 'header']]);
  const context = {
    Object,
    JSON,
    Math,
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-1'
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    }
  };
  load('src/repositories/DataLayerSchema.gs', context);
  load('src/core/SheetWriter.gs', context);
  load('src/repositories/DataLayerProvisioner.gs', context);
  assert.throws(
    () => context.PRADataLayerProvisioner.run(),
    /Cabeçalho incompatível/
  );
  assert.equal(rawOrders.values[0][0], 'wrong');
});
