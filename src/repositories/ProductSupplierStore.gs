var PRAProductSupplierStore = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var LINK_SHEET_NAME = 'raw_product_suppliers';
  var STATUS_SHEET_NAME = 'product_supplier_status';
  var PRODUCT_SHEET_NAME = 'raw_products';
  var LINK_HEADERS = Object.freeze([
    'link_id', 'product_id', 'supplier_id', 'description', 'supplier_sku',
    'cost_price', 'purchase_price', 'is_default', 'updated_at', 'run_id'
  ]);
  var STATUS_HEADERS = Object.freeze([
    'product_id', 'supplier_count', 'link_state', 'primary_supplier_id',
    'primary_link_id', 'primary_rule', 'updated_at', 'run_id'
  ]);
  var ALLOWED_PRIMARY_RULES = Object.freeze([
    'marked_default',
    'lowest_purchase_price',
    'lowest_cost_price',
    'lowest_supplier_id'
  ]);

  function value_(value, fallback) {
    return value === null || typeof value === 'undefined' ? fallback : value;
  }

  function positiveId_(value, label) {
    var candidate = String(value || '');
    if (!/^\d+$/.test(candidate) || Number(candidate) < 1) {
      throw new Error((label || 'ID') + ' técnico inválido no vínculo produto-fornecedor.');
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

  function readRows_(sheet, width) {
    var rowCount = sheet.getLastRow() - 1;
    if (rowCount < 1) return [];
    return sheet.getRange(2, 1, rowCount, width).getValues()
      .filter(function (row) {
        return row.some(function (cell) { return cell !== '' && cell !== null; });
      });
  }

  function replaceRows_(sheet, rows, width) {
    var existingRows = Math.max(sheet.getLastRow() - 1, 0);
    if (existingRows > 0) {
      sheet.getRange(2, 1, existingRows, width).clearContent();
    }
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, width).setValues(rows);
    }
  }

  function mergeByLinkId_(existing, incoming) {
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

  function linkRow_(link, metadata, timestamp) {
    if (!link || typeof link !== 'object') {
      throw new Error('Vínculo produto-fornecedor inválido na página recebida.');
    }
    return [
      positiveId_(link.id, 'ID do vínculo'),
      positiveId_(link.produto && link.produto.id, 'ID do produto'),
      positiveId_(link.fornecedor && link.fornecedor.id, 'ID do fornecedor'),
      String(value_(link.descricao, '')),
      String(value_(link.codigo, '')),
      number_(link.precoCusto),
      number_(link.precoCompra),
      Boolean(link.padrao),
      timestamp,
      String(metadata.runId || '')
    ];
  }

  function persistPage(links, metadata) {
    if (!Array.isArray(links)) {
      throw new Error('A página de vínculos deve ser uma lista.');
    }
    metadata = metadata || {};
    var timestamp = new Date().toISOString();
    var incoming = links.map(function (link) {
      return linkRow_(link, metadata, timestamp);
    });
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = ensureSheet_(spreadsheet, LINK_SHEET_NAME, LINK_HEADERS);
      var merged = mergeByLinkId_(readRows_(sheet, LINK_HEADERS.length), incoming);
      replaceRows_(sheet, merged, LINK_HEADERS.length);
      return {
        ok: true,
        linksStored: incoming.length,
        updatedAt: timestamp
      };
    } finally {
      lock.releaseLock();
    }
  }

  function normalizedRule_(rule) {
    var candidate = String(rule || 'marked_default');
    if (ALLOWED_PRIMARY_RULES.indexOf(candidate) < 0) {
      throw new Error('Regra de fornecedor principal não suportada: ' + candidate);
    }
    return candidate;
  }

  function compareId_(left, right) {
    var a = String(left);
    var b = String(right);
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  function compareNumber_(left, right) {
    var a = Number(left);
    var b = Number(right);
    if (!Number.isFinite(a)) a = Number.POSITIVE_INFINITY;
    if (!Number.isFinite(b)) b = Number.POSITIVE_INFINITY;
    return a - b;
  }

  function defaultTieBreak_(left, right) {
    if (Boolean(left[7]) !== Boolean(right[7])) return Boolean(left[7]) ? -1 : 1;
    return compareId_(left[0], right[0]);
  }

  function choosePrimary_(rows, rule) {
    if (!rows.length) return null;
    var selectedRule = normalizedRule_(rule);
    var sorted = rows.slice();
    sorted.sort(function (left, right) {
      var compared = 0;
      if (selectedRule === 'marked_default') {
        compared = Boolean(left[7]) === Boolean(right[7]) ? 0 : (Boolean(left[7]) ? -1 : 1);
      } else if (selectedRule === 'lowest_purchase_price') {
        compared = compareNumber_(left[6], right[6]);
      } else if (selectedRule === 'lowest_cost_price') {
        compared = compareNumber_(left[5], right[5]);
      } else if (selectedRule === 'lowest_supplier_id') {
        compared = compareId_(left[2], right[2]);
      }
      return compared || defaultTieBreak_(left, right);
    });
    return sorted[0];
  }

  function readProductIds_(spreadsheet) {
    var sheet = spreadsheet.getSheetByName(PRODUCT_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .map(function (row) { return String(row[0] || ''); })
      .filter(function (id) { return /^\d+$/.test(id) && Number(id) > 0; });
  }

  function uniqueIds_(values) {
    var seen = {};
    return values.filter(function (value) {
      var key = String(value);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function sortIds_(ids) {
    return ids.slice().sort(compareId_);
  }

  function finalizeRun(runId, primaryRule) {
    var targetRunId = String(runId || '');
    if (!targetRunId) throw new Error('runId obrigatório para reconciliar vínculos.');
    var selectedRule = normalizedRule_(primaryRule);
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var linkSheet = ensureSheet_(spreadsheet, LINK_SHEET_NAME, LINK_HEADERS);
      var statusSheet = ensureSheet_(spreadsheet, STATUS_SHEET_NAME, STATUS_HEADERS);
      var currentLinks = readRows_(linkSheet, LINK_HEADERS.length).filter(function (row) {
        return String(row[9]) === targetRunId;
      });

      replaceRows_(linkSheet, currentLinks, LINK_HEADERS.length);

      var grouped = {};
      currentLinks.forEach(function (row) {
        var productId = String(row[1]);
        if (!grouped[productId]) grouped[productId] = [];
        grouped[productId].push(row);
      });

      var productIds = uniqueIds_(readProductIds_(spreadsheet).concat(Object.keys(grouped)));
      productIds = sortIds_(productIds);
      var timestamp = new Date().toISOString();
      var counters = { none: 0, single: 0, multiple: 0 };
      var statusRows = productIds.map(function (productId) {
        var links = grouped[productId] || [];
        var supplierIds = uniqueIds_(links.map(function (row) { return String(row[2]); }));
        var supplierCount = supplierIds.length;
        var state = supplierCount === 0 ? 'none' : (supplierCount === 1 ? 'single' : 'multiple');
        counters[state] += 1;
        var primary = choosePrimary_(links, selectedRule);
        return [
          productId,
          supplierCount,
          state,
          primary ? String(primary[2]) : '',
          primary ? String(primary[0]) : '',
          selectedRule,
          timestamp,
          targetRunId
        ];
      });

      replaceRows_(statusSheet, statusRows, STATUS_HEADERS.length);
      return {
        ok: true,
        linksStored: currentLinks.length,
        productsEvaluated: statusRows.length,
        productsWithoutSupplier: counters.none,
        productsWithSingleSupplier: counters.single,
        productsWithMultipleSuppliers: counters.multiple,
        primaryRule: selectedRule,
        updatedAt: timestamp
      };
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({
    persistPage: persistPage,
    finalizeRun: finalizeRun
  });
})();
