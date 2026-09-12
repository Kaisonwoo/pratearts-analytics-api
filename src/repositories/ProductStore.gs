var PRAProductStore = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var SHEET_NAME = 'raw_products';
  var HEADERS = Object.freeze([
    'product_id', 'parent_product_id', 'sku', 'name', 'type', 'status',
    'format', 'price', 'cost_price', 'virtual_stock', 'is_variation',
    'updated_at', 'run_id'
  ]);

  function value_(value, fallback) {
    return value === null || typeof value === 'undefined' ? fallback : value;
  }

  function positiveId_(value, label) {
    var candidate = String(value || '');
    if (!/^\d+$/.test(candidate) || Number(candidate) < 1) {
      throw new Error((label || 'ID') + ' técnico inválido no produto.');
    }
    return candidate;
  }

  function optionalParentId_(product, productId) {
    var raw = value_(product.idProdutoPai, null);
    if (raw === null && product.produtoPai) raw = product.produtoPai.id;
    if (raw === null && product.variacao && product.variacao.produtoPai) {
      raw = product.variacao.produtoPai.id;
    }
    if (raw === null || raw === '' || String(raw) === '0') return '';
    var parentId = positiveId_(raw, 'ID do produto pai');
    if (parentId === productId) {
      throw new Error('Produto não pode referenciar a si próprio como pai.');
    }
    return parentId;
  }

  function number_(value) {
    var candidate = Number(value);
    return Number.isFinite(candidate) ? candidate : 0;
  }

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
    var rowCount = sheet.getLastRow() - 1;
    if (rowCount < 1) return [];
    return sheet.getRange(2, 1, rowCount, HEADERS.length).getValues()
      .filter(function (row) {
        return row.some(function (cell) { return cell !== '' && cell !== null; });
      });
  }

  function replaceRows_(sheet, rows) {
    PRASheetWriter.replaceRows(sheet, HEADERS.length, rows);
  }

  function mergeByProductId_(existing, incoming) {
    var positions = {};
    var merged = existing.map(function (row, position) {
      positions[String(row[0])] = position;
      return row;
    });
    incoming.forEach(function (row) {
      var key = String(row[0]);
      if (Object.prototype.hasOwnProperty.call(positions, key)) {
        merged[positions[key]] = row;
      } else {
        positions[key] = merged.length;
        merged.push(row);
      }
    });
    return merged;
  }

  function productRow_(product, metadata, timestamp) {
    if (!product || typeof product !== 'object') {
      throw new Error('Produto inválido na página recebida.');
    }
    var productId = positiveId_(product.id, 'ID do produto');
    var parentId = optionalParentId_(product, productId);
    return [
      productId,
      parentId,
      String(value_(product.codigo, '')),
      String(value_(product.nome, '')),
      String(value_(product.tipo, '')),
      String(value_(product.situacao, '')),
      String(value_(product.formato, '')),
      number_(product.preco),
      number_(product.precoCusto),
      number_(product.estoque && product.estoque.saldoVirtualTotal),
      Boolean(parentId),
      timestamp,
      String(metadata.runId || '')
    ];
  }

  function persistPage(products, metadata) {
    if (!Array.isArray(products)) {
      throw new Error('A página de produtos deve ser uma lista.');
    }
    metadata = metadata || {};
    var timestamp = new Date().toISOString();
    var incoming = products.map(function (product) {
      return productRow_(product, metadata, timestamp);
    });
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = ensureSheet_(spreadsheet);
      var merged = mergeByProductId_(readRows_(sheet), incoming);
      replaceRows_(sheet, merged);
      return {
        ok: true,
        productsStored: incoming.length,
        parentLinksStored: incoming.filter(function (row) { return Boolean(row[1]); }).length,
        updatedAt: timestamp
      };
    } finally {
      lock.releaseLock();
    }
  }

  function findById(productId) {
    var targetId = positiveId_(productId, 'ID do produto');
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    var sheet = ensureSheet_(spreadsheet);
    var row = readRows_(sheet).find(function (candidate) {
      return String(candidate[0]) === targetId;
    });
    if (!row) return null;
    return HEADERS.reduce(function (product, header, index) {
      product[header] = row[index];
      return product;
    }, {});
  }

  return Object.freeze({
    persistPage: persistPage,
    findById: findById
  });
})();
