var PRAValidSalesService = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var SHEET_NAME = 'stg_orders';

  function attendedStatusId_() {
    var raw = PRAConfig.requirePublicValue(PRAConfig.KEYS.BLING_STATUS_ATENDIDO_ID);
    var candidate = String(raw || '').trim();
    if (!/^\d+$/.test(candidate) || Number(candidate) < 1) {
      throw new Error('BLING_STATUS_ATENDIDO_ID deve conter um ID técnico positivo validado no Bling.');
    }
    return candidate;
  }

  function schema_() {
    var definition = PRADataLayerSchema.getBySheet(SHEET_NAME);
    if (!definition) throw new Error('Esquema não encontrado para a aba ' + SHEET_NAME + '.');
    return definition;
  }

  function requireSheet_(spreadsheet, definition) {
    var sheet = spreadsheet.getSheetByName(definition.sheet);
    if (!sheet) throw new Error('Aba obrigatória ausente: ' + definition.sheet + '.');
    if (sheet.getLastRow() === 0) throw new Error('Cabeçalho ausente na aba ' + definition.sheet + '.');
    var actual = sheet.getRange(1, 1, 1, definition.headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(definition.headers)) {
      throw new Error('Cabeçalho incompatível na aba ' + definition.sheet + '.');
    }
    return sheet;
  }

  function columnIndex_(headers, name) {
    var index = headers.indexOf(name);
    if (index < 0) throw new Error('Coluna obrigatória ausente: ' + name + '.');
    return index;
  }

  function run() {
    var attendedStatusId = attendedStatusId_();
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var definition = schema_();
      var sheet = requireSheet_(spreadsheet, definition);
      var count = sheet.getLastRow() - 1;
      var runId = Utilities.getUuid();
      var evaluated = 0;
      var valid = 0;
      var excluded = 0;

      if (count > 0) {
        var rows = sheet.getRange(2, 1, count, definition.headers.length).getValues();
        var statusIndex = columnIndex_(definition.headers, 'status_id');
        var validIndex = columnIndex_(definition.headers, 'is_valid_sale');
        rows.forEach(function (row) {
          var orderId = String(row[0] || '').trim();
          if (!orderId) return;
          var statusId = String(row[statusIndex] || '').trim();
          var isValid = statusId === attendedStatusId;
          row[validIndex] = isValid;
          evaluated += 1;
          if (isValid) valid += 1;
          else excluded += 1;
        });
        sheet.getRange(2, 1, rows.length, definition.headers.length).setValues(rows);
      }

      var summary = {
        ok: true,
        status: 'completed',
        code: 'valid_sales_classified',
        runId: runId,
        ordersEvaluated: evaluated,
        validOrders: valid,
        excludedOrders: excluded
      };
      PRALogger.info('valid_sales_classified', summary);
      return summary;
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({ run: run });
})();
