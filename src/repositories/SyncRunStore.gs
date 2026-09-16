var PRASyncRunStore = (function () {
  'use strict';

  var SHEET_NAME = 'sync_runs';
  var MAX_ROWS = 500;
  var LOCK_TIMEOUT_MS = 30000;

  function schema_() {
    var schema = PRADataLayerSchema.getBySheet(SHEET_NAME);
    if (!schema) throw new Error('Esquema sync_runs não encontrado.');
    return schema;
  }

  function requireSheet_(spreadsheet, schema) {
    var sheet = spreadsheet.getSheetByName(schema.sheet);
    if (!sheet) throw new Error('Aba sync_runs não provisionada.');
    var actual = sheet.getRange(1, 1, 1, schema.headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(schema.headers)) {
      throw new Error('Cabeçalho incompatível na aba sync_runs.');
    }
    return sheet;
  }

  function readRows_(sheet, width) {
    var count = Math.max(sheet.getLastRow() - 1, 0);
    return count > 0 ? sheet.getRange(2, 1, count, width).getValues() : [];
  }

  function normalizedRow_(entry) {
    entry = entry || {};
    var runId = String(entry.runId || '');
    if (!runId) throw new Error('runId obrigatório para registrar execução.');
    return [
      runId,
      String(entry.jobName || 'daily_sync'),
      String(entry.status || 'started'),
      String(entry.startedAt || ''),
      String(entry.finishedAt || ''),
      entry.durationMs === '' || entry.durationMs == null ? '' : Number(entry.durationMs),
      entry.pagesProcessed === '' || entry.pagesProcessed == null ? '' : Number(entry.pagesProcessed),
      entry.recordsProcessed === '' || entry.recordsProcessed == null
        ? '' : Number(entry.recordsProcessed),
      String(entry.errorCode || ''),
      String(entry.correlationId || runId)
    ];
  }

  function upsert_(entry) {
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var schema = schema_();
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = requireSheet_(spreadsheet, schema);
      var rows = readRows_(sheet, schema.headers.length);
      var next = normalizedRow_(entry);
      var updated = false;
      rows = rows.map(function (row) {
        if (String(row[0]) !== next[0]) return row;
        updated = true;
        return next;
      });
      if (!updated) rows.push(next);
      if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
      PRASheetWriter.replaceRows(sheet, schema.headers.length, rows);
      return { ok: true, runId: next[0], status: next[2], rowsStored: rows.length };
    } finally {
      lock.releaseLock();
    }
  }

  function start(entry) {
    entry = entry || {};
    return upsert_({
      runId: entry.runId,
      jobName: entry.jobName,
      status: 'started',
      startedAt: entry.startedAt,
      finishedAt: '',
      durationMs: '',
      pagesProcessed: '',
      recordsProcessed: '',
      errorCode: '',
      correlationId: entry.correlationId
    });
  }

  function finish(entry) {
    return upsert_(entry || {});
  }

  return Object.freeze({ start: start, finish: finish });
})();
