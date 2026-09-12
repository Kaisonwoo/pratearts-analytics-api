var PRASheetWriter = (function () {
  'use strict';

  function cloneRows_(rows) {
    return rows.map(function (row) { return row.slice(); });
  }

  function validateRows_(rows, width) {
    if (!Array.isArray(rows)) throw new Error('As linhas para gravação devem ser uma lista.');
    if (!Number.isInteger(width) || width < 1) throw new Error('Largura de gravação inválida.');
    rows.forEach(function (row) {
      if (!Array.isArray(row) || row.length !== width) {
        throw new Error('Linha incompatível com a largura esperada da aba.');
      }
    });
  }

  function snapshot_(sheet, width) {
    var count = Math.max(sheet.getLastRow() - 1, 0);
    return {
      sheet: sheet,
      width: width,
      rows: count > 0
        ? cloneRows_(sheet.getRange(2, 1, count, width).getValues())
        : []
    };
  }

  function writeFirst_(sheet, width, rows) {
    validateRows_(rows, width);
    var previousCount = Math.max(sheet.getLastRow() - 1, 0);

    // setValues e uma unica chamada remota. A base anterior so e reduzida
    // depois que o novo conjunto foi confirmado pelo Google Sheets.
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, width).setValues(cloneRows_(rows));
    }
    if (previousCount > rows.length) {
      sheet.getRange(2 + rows.length, 1, previousCount - rows.length, width).clearContent();
    }
  }

  function rollback_(snapshots, lastIndex) {
    var rollbackErrors = [];
    for (var index = lastIndex; index >= 0; index -= 1) {
      try {
        writeFirst_(snapshots[index].sheet, snapshots[index].width, snapshots[index].rows);
      } catch (error) {
        rollbackErrors.push(index);
      }
    }
    return rollbackErrors;
  }

  function replaceMany(operations) {
    if (!Array.isArray(operations) || operations.length < 1) {
      throw new Error('Informe ao menos uma operacao de gravacao.');
    }

    operations.forEach(function (operation) {
      if (!operation || !operation.sheet) throw new Error('Aba de destino obrigatoria.');
      validateRows_(operation.rows, operation.width);
    });

    // Todas as leituras acontecem antes da primeira escrita. Se uma escrita
    // posterior falhar, as abas ja alteradas sao restauradas em ordem inversa.
    var snapshots = operations.map(function (operation) {
      return snapshot_(operation.sheet, operation.width);
    });

    var currentIndex = 0;
    try {
      for (currentIndex = 0; currentIndex < operations.length; currentIndex += 1) {
        writeFirst_(
          operations[currentIndex].sheet,
          operations[currentIndex].width,
          operations[currentIndex].rows
        );
      }
    } catch (error) {
      var rollbackErrors = rollback_(snapshots, Math.min(currentIndex, snapshots.length - 1));
      var safeError = new Error(
        rollbackErrors.length > 0
          ? 'Falha na gravacao e na restauracao da base anterior.'
          : 'Falha na gravacao; a base anterior foi restaurada.'
      );
      safeError.code = rollbackErrors.length > 0
        ? 'sheet_write_rollback_failed'
        : 'sheet_write_failed_rolled_back';
      throw safeError;
    }

    return { ok: true, sheetsWritten: operations.length };
  }

  function replaceRows(sheet, width, rows) {
    return replaceMany([{ sheet: sheet, width: width, rows: rows }]);
  }

  return Object.freeze({
    replaceRows: replaceRows,
    replaceMany: replaceMany
  });
})();
