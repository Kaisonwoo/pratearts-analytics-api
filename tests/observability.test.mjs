import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function load(context, file) {
  vm.runInContext(await readFile(file, 'utf8'), context, { filename: file });
}

function spreadsheetFixture() {
  const headers = [
    'run_id', 'job_name', 'status', 'started_at', 'finished_at',
    'duration_ms', 'pages_processed', 'records_processed', 'error_code',
    'correlation_id'
  ];
  const values = [headers.slice()];
  const sheet = {
    getLastRow() {
      let last = 0;
      values.forEach((row, index) => {
        if (row.some(value => value !== '' && value != null)) last = index + 1;
      });
      return last;
    },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_, r) =>
            Array.from({ length: columnCount }, (_, c) =>
              values[row - 1 + r]?.[column - 1 + c] ?? ''));
        },
        setValues(rows) {
          rows.forEach((source, r) => {
            const target = row - 1 + r;
            if (!values[target]) values[target] = [];
            source.forEach((value, c) => { values[target][column - 1 + c] = value; });
          });
        },
        clearContent() {
          for (let r = row - 1; r < row - 1 + rowCount; r += 1) {
            if (!values[r]) continue;
            for (let c = column - 1; c < column - 1 + columnCount; c += 1) {
              values[r][c] = '';
            }
          }
        }
      };
    }
  };
  return {
    values,
    spreadsheet: { getSheetByName: name => name === 'sync_runs' ? sheet : null }
  };
}

test('sync_runs registra início e consolida o mesmo run_id no término', async () => {
  const fixture = spreadsheetFixture();
  const lock = { waitLock() {}, releaseLock() {} };
  const context = vm.createContext({
    PRAConfig: {
      KEYS: { DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID' },
      requirePublicValue: () => 'sheet-id'
    },
    SpreadsheetApp: { openById: () => fixture.spreadsheet },
    LockService: { getScriptLock: () => lock },
    Object, Array, String, Number, JSON, Math, Error
  });
  await load(context, 'src/repositories/DataLayerSchema.gs');
  await load(context, 'src/core/SheetWriter.gs');
  await load(context, 'src/repositories/SyncRunStore.gs');

  context.PRASyncRunStore.start({
    runId: 'run-1',
    jobName: 'daily_sync',
    startedAt: '2026-09-15T09:02:00.000Z',
    correlationId: 'run-1'
  });
  context.PRASyncRunStore.finish({
    runId: 'run-1',
    jobName: 'daily_sync',
    status: 'completed',
    startedAt: '2026-09-15T09:02:00.000Z',
    finishedAt: '2026-09-15T09:03:00.000Z',
    durationMs: 60000,
    pagesProcessed: 1,
    recordsProcessed: 30,
    errorCode: '',
    correlationId: 'run-1'
  });

  assert.equal(fixture.values.length, 2);
  assert.deepEqual(fixture.values[1], [
    'run-1', 'daily_sync', 'completed', '2026-09-15T09:02:00.000Z',
    '2026-09-15T09:03:00.000Z', 60000, 1, 30, '', 'run-1'
  ]);
});

test('alerta ausente mantém código estável e não faz chamada externa', async () => {
  let fetches = 0;
  const logs = [];
  const context = vm.createContext({
    PRASecrets: { getGoogleChatAlertWebhook: () => null },
    PRALogger: {
      warn: (event, metadata) => logs.push({ event, metadata }),
      info() {},
      error() {}
    },
    UrlFetchApp: { fetch: () => { fetches += 1; } },
    Date, String, Number, JSON, Object
  });
  await load(context, 'src/services/AlertService.gs');
  const result = context.PRAAlertService.notifyCritical({
    code: 'daily_sync_blocked',
    correlationId: 'corr-1'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    configured: false,
    delivered: false,
    code: 'alert_not_configured'
  });
  assert.equal(fetches, 0);
  assert.equal(logs[0].event, 'critical_alert_not_configured');
});

test('alerta recusa webhook fora do domínio autorizado', async () => {
  let fetches = 0;
  const logs = [];
  const context = vm.createContext({
    PRASecrets: { getGoogleChatAlertWebhook: () => 'https://example.com/hook' },
    PRALogger: {
      warn() {},
      info() {},
      error: (event, metadata) => logs.push({ event, metadata })
    },
    UrlFetchApp: { fetch: () => { fetches += 1; } },
    Date, String, Number, JSON, Object
  });
  await load(context, 'src/services/AlertService.gs');
  const result = context.PRAAlertService.notifyCritical({
    code: 'daily_sync_blocked',
    correlationId: 'corr-2'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    configured: true,
    delivered: false,
    code: 'alert_invalid_configuration'
  });
  assert.equal(fetches, 0);
  assert.equal(logs[0].event, 'critical_alert_invalid_configuration');
});

test('alerta envia somente contexto técnico seguro ao Google Chat', async () => {
  const calls = [];
  const logs = [];
  const webhook = 'https://chat.googleapis.com/v1/spaces/test/messages?key=secret';
  const context = vm.createContext({
    PRASecrets: { getGoogleChatAlertWebhook: () => webhook },
    PRALogger: {
      warn() {},
      info: (event, metadata) => logs.push({ event, metadata }),
      error: (event, metadata) => logs.push({ event, metadata })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.push({ url, options });
        return { getResponseCode: () => 200 };
      }
    },
    Date, String, Number, JSON, Object
  });
  await load(context, 'src/services/AlertService.gs');
  const result = context.PRAAlertService.notifyCritical({
    jobName: 'daily_sync',
    code: 'daily_sync_blocked',
    correlationId: 'corr-1',
    timestamp: '2026-09-15T09:03:00.000Z'
  });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.payload);
  assert.match(payload.text, /daily_sync_blocked/);
  assert.match(payload.text, /corr-1/);
  assert.doesNotMatch(payload.text, /key=secret/);
  assert.equal(JSON.stringify(logs).includes('key=secret'), false);
});
