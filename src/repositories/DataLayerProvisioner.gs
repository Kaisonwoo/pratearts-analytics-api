var PRADataLayerProvisioner = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;

  function ensureSheet_(spreadsheet, definition) {
    var sheet = spreadsheet.getSheetByName(definition.sheet) || spreadsheet.insertSheet(definition.sheet);
    var headers = definition.headers;
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
      sheet.setFrozenRows(1);
      return true;
    }
    var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(headers)) {
      throw new Error('Cabeçalho incompatível na aba ' + definition.sheet + '.');
    }
    return false;
  }

  function syncRegistry_(spreadsheet, definitions) {
    var headers = PRADataLayerSchema.METADATA_HEADERS.slice();
    var name = PRADataLayerSchema.METADATA_SHEET;
    var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    } else {
      var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (JSON.stringify(actual) !== JSON.stringify(headers)) {
        throw new Error('Cabeçalho incompatível na aba ' + name + '.');
      }
    }

    var rows = definitions.map(function (definition) {
      return [
        definition.sheet,
        definition.layer,
        definition.key,
        definition.headers.length,
        PRADataLayerSchema.VERSION
      ];
    });
    PRASheetWriter.replaceRows(sheet, headers.length, rows);
    return rows.length;
  }

  function run() {
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var definitions = PRADataLayerSchema.list();
      var created = 0;
      definitions.forEach(function (definition) {
        if (ensureSheet_(spreadsheet, definition)) created += 1;
      });
      return {
        ok: true,
        schemaVersion: PRADataLayerSchema.VERSION,
        sheetsVerified: definitions.length,
        sheetsCreated: created,
        metadataRows: syncRegistry_(spreadsheet, definitions)
      };
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({ run: run });
})();
