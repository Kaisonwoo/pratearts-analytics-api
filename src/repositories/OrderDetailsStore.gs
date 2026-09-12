var PRAOrderDetailsStore = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var SHEETS = Object.freeze({
    ORDERS: 'raw_orders',
    ITEMS: 'raw_order_items',
    ERRORS: 'order_detail_errors'
  });
  var ORDER_HEADERS = Object.freeze([
    'order_id', 'order_number', 'store_order_number', 'order_date',
    'departure_date', 'expected_date', 'status_id', 'store_id', 'category_id',
    'seller_id', 'products_total', 'order_total', 'other_expenses', 'freight',
    'discount_value', 'discount_unit', 'updated_at', 'run_id'
  ]);
  var ITEM_HEADERS = Object.freeze([
    'item_key', 'order_id', 'item_id', 'product_id', 'sku', 'unit',
    'quantity', 'unit_value', 'discount', 'source_position', 'updated_at', 'run_id'
  ]);
  var ERROR_HEADERS = Object.freeze([
    'order_id', 'error_code', 'status_code', 'correlation_id', 'attempts',
    'last_attempt_at', 'run_id', 'resolved_at'
  ]);

  function value_(value, fallback) {
    return value === null || typeof value === 'undefined' ? fallback : value;
  }

  function id_(value) {
    var candidate = String(value || '');
    if (!/^\d+$/.test(candidate) || Number(candidate) < 1) {
      throw new Error('ID técnico inválido no detalhe do pedido.');
    }
    return candidate;
  }

  function number_(value) {
    var candidate = Number(value);
    return Number.isFinite(candidate) ? candidate : 0;
  }

  function ensureSheet_(spreadsheet, name, headers) {
    var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
      sheet.setFrozenRows(1);
      return sheet;
    }
    var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(headers)) {
      throw new Error('Cabeçalho incompatível na aba ' + name + '.');
    }
    return sheet;
  }

  function readRows_(sheet, headers) {
    var rowCount = sheet.getLastRow() - 1;
    if (rowCount < 1) return [];
    return sheet.getRange(2, 1, rowCount, headers.length).getValues()
      .filter(function (row) {
        return row.some(function (cell) { return cell !== '' && cell !== null; });
      });
  }

  function mergeByKey_(existing, incoming, keyIndex) {
    var positions = {};
    var merged = existing.map(function (row, position) {
      positions[String(row[keyIndex])] = position;
      return row;
    });
    incoming.forEach(function (row) {
      var key = String(row[keyIndex]);
      if (Object.prototype.hasOwnProperty.call(positions, key)) {
        merged[positions[key]] = row;
      } else {
        positions[key] = merged.length;
        merged.push(row);
      }
    });
    return merged;
  }

  function orderRow_(detail, metadata, timestamp) {
    var orderId = id_(detail.id);
    return [
      orderId,
      value_(detail.numero, ''),
      value_(detail.numeroLoja, ''),
      value_(detail.data, ''),
      value_(detail.dataSaida, ''),
      value_(detail.dataPrevista, ''),
      detail.situacao && detail.situacao.id ? String(detail.situacao.id) : '',
      detail.loja && detail.loja.id ? String(detail.loja.id) : '',
      detail.categoria && detail.categoria.id ? String(detail.categoria.id) : '',
      detail.vendedor && detail.vendedor.id ? String(detail.vendedor.id) : '',
      number_(detail.totalProdutos),
      number_(detail.total),
      number_(detail.outrasDespesas),
      number_(detail.transporte && detail.transporte.frete),
      number_(detail.desconto && detail.desconto.valor),
      value_(detail.desconto && detail.desconto.unidade, ''),
      timestamp,
      String(metadata.runId || '')
    ];
  }

  function itemRows_(detail, metadata, timestamp) {
    var orderId = id_(detail.id);
    if (!Array.isArray(detail.itens)) {
      throw new Error('O detalhe do pedido não contém uma lista de itens.');
    }
    return detail.itens.map(function (item, position) {
      var itemId = item && item.id ? String(item.id) : '';
      var itemKey = orderId + ':' + (itemId || 'position-' + (position + 1));
      return [
        itemKey,
        orderId,
        itemId,
        item && item.produto && item.produto.id ? String(item.produto.id) : '',
        value_(item && item.codigo, ''),
        value_(item && item.unidade, ''),
        number_(item && item.quantidade),
        number_(item && item.valor),
        number_(item && item.desconto),
        position + 1,
        timestamp,
        String(metadata.runId || '')
      ];
    });
  }

  function errorRow_(failure, metadata, timestamp, existingResolvedAt) {
    return [
      id_(failure.orderId),
      String(failure.errorCode || 'unknown_error'),
      value_(failure.statusCode, ''),
      String(failure.correlationId || ''),
      number_(failure.attempts),
      timestamp,
      String(metadata.runId || ''),
      existingResolvedAt || ''
    ];
  }

  function persistBatch(details, failures, metadata) {
    details = Array.isArray(details) ? details : [];
    failures = Array.isArray(failures) ? failures : [];
    metadata = metadata || {};
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var ordersSheet = ensureSheet_(spreadsheet, SHEETS.ORDERS, ORDER_HEADERS);
      var itemsSheet = ensureSheet_(spreadsheet, SHEETS.ITEMS, ITEM_HEADERS);
      var errorsSheet = ensureSheet_(spreadsheet, SHEETS.ERRORS, ERROR_HEADERS);
      var timestamp = new Date().toISOString();

      var existingOrders = readRows_(ordersSheet, ORDER_HEADERS);
      var incomingOrders = details.map(function (detail) {
        return orderRow_(detail, metadata, timestamp);
      });
      var mergedOrders = mergeByKey_(existingOrders, incomingOrders, 0);

      var affectedOrderIds = {};
      details.forEach(function (detail) { affectedOrderIds[id_(detail.id)] = true; });
      var existingItems = readRows_(itemsSheet, ITEM_HEADERS).filter(function (row) {
        return !affectedOrderIds[String(row[1])];
      });
      var incomingItems = details.reduce(function (rows, detail) {
        return rows.concat(itemRows_(detail, metadata, timestamp));
      }, []);
      var mergedItems = existingItems.concat(incomingItems);

      var existingErrors = readRows_(errorsSheet, ERROR_HEADERS);
      var errorByOrder = {};
      existingErrors.forEach(function (row) { errorByOrder[String(row[0])] = row; });
      details.forEach(function (detail) {
        var orderId = id_(detail.id);
        if (errorByOrder[orderId]) errorByOrder[orderId][7] = timestamp;
      });
      failures.forEach(function (failure) {
        var orderId = id_(failure.orderId);
        errorByOrder[orderId] = errorRow_(failure, metadata, timestamp, '');
      });
      var mergedErrors = Object.keys(errorByOrder).map(function (key) {
        return errorByOrder[key];
      });

      PRASheetWriter.replaceMany([
        { sheet: ordersSheet, width: ORDER_HEADERS.length, rows: mergedOrders },
        { sheet: itemsSheet, width: ITEM_HEADERS.length, rows: mergedItems },
        { sheet: errorsSheet, width: ERROR_HEADERS.length, rows: mergedErrors }
      ]);

      var unresolvedErrors = mergedErrors.filter(function (row) { return !row[7]; }).length;

      return {
        ok: true,
        ordersStored: incomingOrders.length,
        itemsStored: incomingItems.length,
        errorsStored: failures.length,
        unresolvedErrors: unresolvedErrors,
        updatedAt: timestamp
      };
    } finally {
      lock.releaseLock();
    }
  }

  function getUnresolvedErrorCount() {
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = ensureSheet_(spreadsheet, SHEETS.ERRORS, ERROR_HEADERS);
      return readRows_(sheet, ERROR_HEADERS).filter(function (row) { return !row[7]; }).length;
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({
    persistBatch: persistBatch,
    getUnresolvedErrorCount: getUnresolvedErrorCount
  });
})();
