var PRARecalculationWindowStore = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var SHEET_NAME = 'recalc_windows';
  var HEADERS = Object.freeze([
    'recalc_key', 'window_start', 'window_end', 'reason', 'status', 'marked_at', 'run_id'
  ]);

  function ensureSheet_(spreadsheet) {
    var sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS.slice()]);
      sheet.setFrozenRows(1);
      return sheet;
    }
    var actual = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(HEADERS)) {
      throw new Error('Cabeçalho incompatível na aba ' + SHEET_NAME + '.');
    }
    return sheet;
  }

  function readRows_(sheet) {
    var count = sheet.getLastRow() - 1;
    if (count < 1) return [];
    return sheet.getRange(2, 1, count, HEADERS.length).getValues().filter(function (row) {
      return row.some(function (cell) { return cell !== '' && cell !== null; });
    });
  }

  function replaceRows_(sheet, rows) {
    var existing = Math.max(sheet.getLastRow() - 1, 0);
    if (existing > 0) sheet.getRange(2, 1, existing, HEADERS.length).clearContent();
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }

  function markWindow(windowStart, windowEnd, reason, runId) {
    var start = String(windowStart || '');
    var end = String(windowEnd || '');
    var markerReason = String(reason || 'historical_reconciliation');
    var markerRunId = String(runId || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error('Janela de recálculo inválida.');
    }
    if (!markerRunId) throw new Error('runId obrigatório para marcar recálculo.');

    var key = start + ':' + end + ':' + markerReason;
    var timestamp = new Date().toISOString();
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = ensureSheet_(spreadsheet);
      var rows = readRows_(sheet);
      var position = -1;
      for (var i = 0; i < rows.length; i += 1) {
        if (String(rows[i][0]) === key) {
          position = i;
          break;
        }
      }
      var row = [key, start, end, markerReason, 'pending', timestamp, markerRunId];
      if (position >= 0) rows[position] = row;
      else rows.push(row);
      replaceRows_(sheet, rows);
      return { ok: true, recalcKey: key, status: 'pending', markedAt: timestamp };
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({ markWindow: markWindow });
})();
