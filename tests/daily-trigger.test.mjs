import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();

async function fixture() {
  const values = new Map();
  const triggers = [];
  const created = [];
  const deleted = [];
  let failCreate = false;
  let hour = 6;
  let timezone = 'America/Sao_Paulo';

  function makeTrigger(handler, schedule = {}) {
    return {
      handler,
      schedule,
      getHandlerFunction: () => handler
    };
  }

  const context = vm.createContext({
    PRAConfig: {
      getPublicSnapshot: () => ({
        syncHour: hour,
        syncTimezone: timezone,
        validation: { valid: true, missing: [], invalid: [] }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => values.has(key) ? values.get(key) : null,
        setProperty: (key, value) => { values.set(key, value); },
        deleteProperty: key => { values.delete(key); }
      })
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: trigger => {
        deleted.push(trigger);
        const index = triggers.indexOf(trigger);
        if (index >= 0) triggers.splice(index, 1);
      },
      newTrigger: handler => {
        const schedule = {};
        const builder = {
          timeBased() { return builder; },
          atHour(value) { schedule.hour = value; return builder; },
          nearMinute(value) { schedule.minute = value; return builder; },
          everyDays(value) { schedule.everyDays = value; return builder; },
          inTimezone(value) { schedule.timezone = value; return builder; },
          create() {
            if (failCreate) throw new Error('synthetic trigger failure');
            const trigger = makeTrigger(handler, schedule);
            triggers.push(trigger);
            created.push(trigger);
            return trigger;
          }
        };
        return builder;
      }
    },
    PRALogger: { info() {}, error() {} },
    Object, Array, Number, String, Boolean, Error, Math
  });
  vm.runInContext(
    await readFile(path.join(root, 'src/core/DailyTriggerScheduler.gs'), 'utf8'),
    context,
    { filename: 'src/core/DailyTriggerScheduler.gs' }
  );

  return {
    context, values, triggers, created, deleted,
    setConfig(nextHour, nextTimezone = timezone) { hour = nextHour; timezone = nextTimezone; },
    failNextCreate() { failCreate = true; },
    addTrigger(handler) { const trigger = makeTrigger(handler); triggers.push(trigger); return trigger; }
  };
}

test('instala agenda diaria configurada e evita duplicacao', async () => {
  const f = await fixture();
  const first = f.context.PRADailyTriggerScheduler.install();
  assert.equal(first.created, true);
  assert.equal(first.configured, true);
  assert.equal(first.hour, 6);
  assert.equal(first.timezone, 'America/Sao_Paulo');
  assert.equal(f.created[0].schedule.hour, 6);
  assert.equal(f.created[0].schedule.minute, 0);
  assert.equal(f.created[0].schedule.everyDays, 1);
  assert.equal(f.created[0].schedule.timezone, 'America/Sao_Paulo');

  const second = f.context.PRADailyTriggerScheduler.install();
  assert.equal(second.created, false);
  assert.equal(second.replaced, 0);
  assert.equal(f.triggers.length, 1);
  assert.equal(f.created.length, 1);
});

test('mudanca de horario cria substituto antes de remover agenda anterior', async () => {
  const f = await fixture();
  f.context.PRADailyTriggerScheduler.install();
  const previous = f.triggers[0];
  f.setConfig(7);

  const result = f.context.PRADailyTriggerScheduler.install();
  assert.equal(result.created, true);
  assert.equal(result.replaced, 1);
  assert.equal(f.triggers.length, 1);
  assert.notEqual(f.triggers[0], previous);
  assert.equal(f.triggers[0].schedule.hour, 7);
  assert.equal(f.deleted[0], previous);
});

test('falha ao criar substituto preserva agenda funcional anterior', async () => {
  const f = await fixture();
  f.context.PRADailyTriggerScheduler.install();
  const previous = f.triggers[0];
  f.setConfig(8);
  f.failNextCreate();

  assert.throws(
    () => f.context.PRADailyTriggerScheduler.install(),
    /Nao foi possivel instalar/
  );
  assert.equal(f.triggers.length, 1);
  assert.equal(f.triggers[0], previous);
  assert.equal(f.deleted.length, 0);
});

test('remove apenas agenda recorrente e preserva continuacoes', async () => {
  const f = await fixture();
  f.context.PRADailyTriggerScheduler.install();
  const continuation = f.addTrigger('runDailySyncContinuation');

  const result = f.context.PRADailyTriggerScheduler.remove();
  assert.equal(result.deleted, 1);
  assert.equal(result.installed, 0);
  assert.deepEqual(f.triggers, [continuation]);
  assert.equal(f.context.PRADailyTriggerScheduler.status().configured, false);
});
