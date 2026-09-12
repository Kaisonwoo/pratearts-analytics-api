import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';

const root = process.cwd();

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
    if (this.sheet.failNextSetValues > 0) {
      this.sheet.failNextSetValues -= 1;
      throw new Error('synthetic write failure');
    }
    values.forEach((source, rowOffset) => {
      const target = this.row - 1 + rowOffset;
      if (!this.sheet.rows[target]) this.sheet.rows[target] = [];
      source.forEach((value, columnOffset) => {
        this.sheet.rows[target][this.column - 1 + columnOffset] = value;
      });
    });
    return this;
  }

  clearContent() {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const target = this.row - 1 + rowOffset;
      if (!this.sheet.rows[target]) continue;
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.rows[target][this.column - 1 + columnOffset] = '';
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((row) => row.slice());
    this.failNextSetValues = 0;
  }

  getLastRow() {
    let last = 0;
    this.rows.forEach((row, index) => {
      if (row.some((cell) => cell !== '' && cell !== null)) last = index + 1;
    });
    return last;
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }
}

async function load(relative, context) {
  vm.runInContext(
    await readFile(path.join(root, relative), 'utf8'),
    context,
    { filename: relative }
  );
}

test('gravação multiaba restaura todas as bases quando uma etapa falha', async () => {
  const first = new FakeSheet([['id', 'value'], ['1', 'old-a']]);
  const second = new FakeSheet([['id', 'value'], ['2', 'old-b']]);
  second.failNextSetValues = 1;
  const context = vm.createContext({ Object, Array, Number, Error, Math });
  await load('src/core/SheetWriter.gs', context);
  context.first = first;
  context.second = second;

  assert.throws(
    () => vm.runInContext(`PRASheetWriter.replaceMany([
      { sheet: first, width: 2, rows: [['1', 'new-a']] },
      { sheet: second, width: 2, rows: [['2', 'new-b']] }
    ])`, context),
    /base anterior foi restaurada/
  );
  assert.deepEqual(first.rows[1], ['1', 'old-a']);
  assert.deepEqual(second.rows[1], ['2', 'old-b']);
});

test('gravação escreve antes de remover a cauda antiga', async () => {
  const sheet = new FakeSheet([
    ['id', 'value'],
    ['1', 'old-a'],
    ['2', 'old-b']
  ]);
  const context = vm.createContext({ Object, Array, Number, Error, Math });
  await load('src/core/SheetWriter.gs', context);
  context.sheet = sheet;

  vm.runInContext(
    "PRASheetWriter.replaceRows(sheet, 2, [['1', 'new-a']])",
    context
  );
  assert.deepEqual(sheet.rows[1], ['1', 'new-a']);
  assert.deepEqual(sheet.rows[2], ['', '']);
});

test('agendador evita gatilhos de continuação duplicados e permite cancelamento', async () => {
  const triggers = [];
  const context = vm.createContext({
    Object,
    Array,
    Number,
    String,
    Error,
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger: (handler) => ({
        timeBased() { return this; },
        after() { return this; },
        create() {
          triggers.push({ getHandlerFunction: () => handler });
          return this;
        }
      }),
      deleteTrigger: (trigger) => {
        const index = triggers.indexOf(trigger);
        if (index >= 0) triggers.splice(index, 1);
      }
    }
  });
  await load('src/core/ContinuationScheduler.gs', context);

  const first = context.PRAContinuationScheduler.schedule('runDailySyncContinuation', 60000);
  const duplicate = context.PRAContinuationScheduler.schedule('runDailySyncContinuation', 60000);
  assert.equal(first.scheduled, true);
  assert.equal(duplicate.scheduled, false);
  assert.equal(triggers.length, 1);

  const cancelled = context.PRAContinuationScheduler.cancel('runDailySyncContinuation');
  assert.equal(cancelled.deleted, 1);
  assert.equal(triggers.length, 0);
});

test('lease impede uma segunda execução e libera somente o próprio token', async () => {
  const values = new Map();
  const properties = {
    getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperties: (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
    deleteProperty: (key) => values.delete(key)
  };
  let uuid = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => `lease-${++uuid}` },
    Date, Object, Number, String, JSON, Error, Math
  });
  await load('src/core/ExecutionLease.gs', context);

  const first = context.PRAExecutionLease.acquire('orders_incremental_sync');
  const blocked = context.PRAExecutionLease.acquire('orders_incremental_sync');
  assert.equal(first.acquired, true);
  assert.equal(blocked.acquired, false);
  assert.equal(context.PRAExecutionLease.release(blocked), false);
  assert.equal(context.PRAExecutionLease.release(first), true);
  assert.equal(context.PRAExecutionLease.acquire('orders_incremental_sync').acquired, true);
});

test('orçamento compartilhado respeita um deadline que já expirou', async () => {
  class FakeDate extends Date {
    static now() { return 2000; }
  }
  const context = vm.createContext({ Date: FakeDate, Object, Number, Math, Error });
  await load('src/core/RuntimeBudget.gs', context);

  const budget = context.PRARuntimeBudget.create({
    budgetMs: 1000,
    deadlineAtMs: 1000,
    reserveMs: 0
  });
  assert.equal(budget.remainingMs(), 0);
  assert.equal(budget.shouldYield(), true);
});
