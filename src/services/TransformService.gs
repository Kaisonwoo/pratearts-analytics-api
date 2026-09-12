var PRATransformService = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var NORMALIZATION_PREFIX = 'normalization:';

  function schema_(sheetName) {
    var definition = PRADataLayerSchema.getBySheet(sheetName);
    if (!definition) throw new Error('Esquema não encontrado para a aba ' + sheetName + '.');
    return definition;
  }

  function ensureTargetSheet_(spreadsheet, definition) {
    var sheet = spreadsheet.getSheetByName(definition.sheet) || spreadsheet.insertSheet(definition.sheet);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers.slice()]);
      sheet.setFrozenRows(1);
      return sheet;
    }
    var actual = sheet.getRange(1, 1, 1, definition.headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(definition.headers)) {
      throw new Error('Cabeçalho incompatível na aba ' + definition.sheet + '.');
    }
    return sheet;
  }

  function requireSourceSheet_(spreadsheet, definition) {
    var sheet = spreadsheet.getSheetByName(definition.sheet);
    if (!sheet) throw new Error('Aba de origem obrigatória ausente: ' + definition.sheet + '.');
    if (sheet.getLastRow() === 0) {
      throw new Error('Cabeçalho ausente na aba de origem ' + definition.sheet + '.');
    }
    var actual = sheet.getRange(1, 1, 1, definition.headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(definition.headers)) {
      throw new Error('Cabeçalho incompatível na aba ' + definition.sheet + '.');
    }
    return sheet;
  }

  function readObjects_(sheet, definition) {
    var count = sheet.getLastRow() - 1;
    if (count < 1) return [];
    return sheet.getRange(2, 1, count, definition.headers.length).getValues()
      .map(function (row, index) {
        var object = { _sourceRow: index + 2 };
        definition.headers.forEach(function (header, column) {
          object[header] = row[column];
        });
        return object;
      })
      .filter(function (object) {
        return definition.headers.some(function (header) {
          return object[header] !== '' && object[header] !== null;
        });
      });
  }

  function readRows_(sheet, definition) {
    var count = sheet.getLastRow() - 1;
    if (count < 1) return [];
    return sheet.getRange(2, 1, count, definition.headers.length).getValues()
      .filter(function (row) {
        return row.some(function (cell) { return cell !== '' && cell !== null; });
      });
  }

  function text_(value) {
    if (value === null || typeof value === 'undefined') return '';
    return String(value).trim();
  }

  function isBlank_(value) {
    return value === '' || value === null || typeof value === 'undefined';
  }

  function addError_(errors, entityType, entityKey, code, severity, processedAt, runId) {
    var safeEntityKey = text_(entityKey) || 'unknown';
    var errorKey = NORMALIZATION_PREFIX + entityType + ':' + safeEntityKey + ':' + code;
    errors[errorKey] = [
      errorKey,
      entityType,
      safeEntityKey,
      code,
      severity || 'warning',
      processedAt,
      '',
      runId
    ];
  }

  function positiveId_(value, fieldName, entityType, entityKey, required, errors, processedAt, runId) {
    var candidate = text_(value);
    if (!candidate) {
      if (required) {
        addError_(errors, entityType, entityKey, 'missing_' + fieldName, 'error', processedAt, runId);
      }
      return '';
    }
    if (!/^\d+$/.test(candidate) || Number(candidate) < 1) {
      addError_(errors, entityType, entityKey, 'invalid_' + fieldName, required ? 'error' : 'warning', processedAt, runId);
      return '';
    }
    return candidate;
  }

  function date_(value, fieldName, entityType, entityKey, required, errors, processedAt, runId) {
    if (isBlank_(value)) {
      if (required) {
        addError_(errors, entityType, entityKey, 'missing_' + fieldName, 'warning', processedAt, runId);
      }
      return '';
    }
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    var candidate = text_(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
      addError_(errors, entityType, entityKey, 'invalid_' + fieldName, 'warning', processedAt, runId);
      return '';
    }
    var parsed = Date.parse(candidate + 'T00:00:00Z');
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== candidate) {
      addError_(errors, entityType, entityKey, 'invalid_' + fieldName, 'warning', processedAt, runId);
      return '';
    }
    return candidate;
  }

  function timestamp_(value, entityType, entityKey, errors, processedAt, runId) {
    if (isBlank_(value)) {
      addError_(errors, entityType, entityKey, 'missing_source_updated_at', 'warning', processedAt, runId);
      return '';
    }
    var parsed = Object.prototype.toString.call(value) === '[object Date]'
      ? value.getTime()
      : Date.parse(String(value));
    if (!Number.isFinite(parsed)) {
      addError_(errors, entityType, entityKey, 'invalid_source_updated_at', 'warning', processedAt, runId);
      return '';
    }
    return new Date(parsed).toISOString();
  }

  function number_(value, fieldName, entityType, entityKey, required, errors, processedAt, runId) {
    if (isBlank_(value)) {
      if (required) {
        addError_(errors, entityType, entityKey, 'missing_' + fieldName, 'warning', processedAt, runId);
      }
      return 0;
    }
    var candidate = Number(value);
    if (!Number.isFinite(candidate)) {
      addError_(errors, entityType, entityKey, 'invalid_' + fieldName, 'warning', processedAt, runId);
      return 0;
    }
    return candidate;
  }

  function validNumberInput_(value, allowBlank) {
    if (isBlank_(value)) return Boolean(allowBlank);
    return Number.isFinite(Number(value));
  }

  function orderRow_(raw, errors, processedAt, runId) {
    var fallbackKey = 'row-' + raw._sourceRow;
    var orderId = positiveId_(
      raw.order_id, 'order_id', 'order', fallbackKey, true, errors, processedAt, runId
    );
    if (!orderId) return null;

    var statusId = positiveId_(
      raw.status_id, 'status_id', 'order', orderId, false, errors, processedAt, runId
    );
    if (!statusId) {
      addError_(errors, 'order', orderId, 'missing_status_id', 'warning', processedAt, runId);
    }

    return [
      orderId,
      text_(raw.order_number),
      date_(raw.order_date, 'order_date', 'order', orderId, true, errors, processedAt, runId),
      statusId,
      number_(raw.products_total, 'products_total', 'order', orderId, true, errors, processedAt, runId),
      number_(raw.order_total, 'order_total', 'order', orderId, true, errors, processedAt, runId),
      number_(raw.freight, 'freight', 'order', orderId, false, errors, processedAt, runId),
      number_(raw.discount_value, 'discount_value', 'order', orderId, false, errors, processedAt, runId),
      '',
      timestamp_(raw.updated_at, 'order', orderId, errors, processedAt, runId),
      processedAt,
      runId
    ];
  }

  function itemRow_(raw, stagedOrderIds, errors, processedAt, runId) {
    var fallbackKey = 'row-' + raw._sourceRow;
    var itemKey = text_(raw.item_key);
    if (!itemKey) {
      addError_(errors, 'order_item', fallbackKey, 'missing_item_key', 'error', processedAt, runId);
      return null;
    }
    var orderId = positiveId_(
      raw.order_id, 'order_id', 'order_item', itemKey, true, errors, processedAt, runId
    );
    if (!orderId) return null;
    if (!stagedOrderIds[orderId]) {
      addError_(errors, 'order_item', itemKey, 'orphan_order', 'error', processedAt, runId);
    }

    var productId = positiveId_(
      raw.product_id, 'product_id', 'order_item', itemKey, false, errors, processedAt, runId
    );
    if (!productId) {
      addError_(errors, 'order_item', itemKey, 'missing_product_id', 'warning', processedAt, runId);
    }
    var sku = text_(raw.sku);
    if (!sku) {
      addError_(errors, 'order_item', itemKey, 'missing_sku', 'warning', processedAt, runId);
    }

    var quantity = number_(
      raw.quantity, 'quantity', 'order_item', itemKey, true, errors, processedAt, runId
    );
    var unitValue = number_(
      raw.unit_value, 'unit_value', 'order_item', itemKey, true, errors, processedAt, runId
    );
    var discount = number_(
      raw.discount, 'discount', 'order_item', itemKey, false, errors, processedAt, runId
    );
    var itemRevenue = '';
    var revenueInputsValid = validNumberInput_(raw.quantity, false) &&
      validNumberInput_(raw.unit_value, false) && validNumberInput_(raw.discount, true);
    try {
      if (!revenueInputsValid) throw new Error('Entradas numéricas inválidas.');
      itemRevenue = PRAKpiService.calculateItemRevenue(quantity, unitValue, discount);
    } catch (error) {
      addError_(
        errors, 'order_item', itemKey, 'invalid_item_revenue_inputs',
        'error', processedAt, runId
      );
    }

    return [
      itemKey,
      orderId,
      productId,
      sku,
      quantity,
      unitValue,
      discount,
      itemRevenue,
      timestamp_(raw.updated_at, 'order_item', itemKey, errors, processedAt, runId),
      processedAt,
      runId
    ];
  }

  function compareKeys_(left, right) {
    var a = String(left[0]);
    var b = String(right[0]);
    if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  function mergeQualityErrors_(existingRows, currentErrors, processedAt, runId) {
    var currentKeys = {};
    Object.keys(currentErrors).forEach(function (key) { currentKeys[key] = true; });
    var merged = [];
    var existingByKey = {};

    existingRows.forEach(function (row) {
      var key = String(row[0] || '');
      existingByKey[key] = row.slice();
      if (key.indexOf(NORMALIZATION_PREFIX) !== 0) {
        merged.push(row.slice());
      }
    });

    Object.keys(currentErrors).sort().forEach(function (key) {
      var row = currentErrors[key].slice();
      var previous = existingByKey[key];
      if (previous && previous[5]) row[5] = previous[5];
      merged.push(row);
    });

    Object.keys(existingByKey).sort().forEach(function (key) {
      if (key.indexOf(NORMALIZATION_PREFIX) !== 0 || currentKeys[key]) return;
      var resolved = existingByKey[key].slice();
      if (!resolved[6]) resolved[6] = processedAt;
      resolved[7] = runId;
      merged.push(resolved);
    });

    return merged;
  }

  function run(options) {
    options = options || {};
    var policy = PRAConfig.getRequestPolicy ? PRAConfig.getRequestPolicy() : {};
    var budget = PRARuntimeBudget.create({
      budgetMs: options.maxRuntimeMs || policy.executionBudgetMs || 270000,
      deadlineAtMs: options.deadlineAtMs,
      reserveMs: typeof options.reserveMs === 'undefined' ? 15000 : options.reserveMs
    });
    var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var rawOrdersSchema = schema_('raw_orders');
      var rawItemsSchema = schema_('raw_order_items');
      var stgOrdersSchema = schema_('stg_orders');
      var stgItemsSchema = schema_('stg_order_items');
      var qualitySchema = schema_('data_quality_errors');

      var rawOrders = readObjects_(requireSourceSheet_(spreadsheet, rawOrdersSchema), rawOrdersSchema);
      var rawItems = readObjects_(requireSourceSheet_(spreadsheet, rawItemsSchema), rawItemsSchema);
      var stgOrdersSheet = ensureTargetSheet_(spreadsheet, stgOrdersSchema);
      var stgItemsSheet = ensureTargetSheet_(spreadsheet, stgItemsSchema);
      var qualitySheet = ensureTargetSheet_(spreadsheet, qualitySchema);

      var processedAt = new Date().toISOString();
      var runId = Utilities.getUuid();
      var errors = {};
      var stagedOrders = rawOrders.map(function (raw) {
        return orderRow_(raw, errors, processedAt, runId);
      }).filter(Boolean).sort(compareKeys_);

      var stagedOrderIds = {};
      stagedOrders.forEach(function (row) { stagedOrderIds[String(row[0])] = true; });

      var stagedItems = rawItems.map(function (raw) {
        return itemRow_(raw, stagedOrderIds, errors, processedAt, runId);
      }).filter(Boolean).sort(compareKeys_);
      var itemRevenueCalculated = stagedItems.filter(function (row) {
        return row[7] !== '' && row[7] !== null;
      }).length;
      var itemRevenueErrors = stagedItems.length - itemRevenueCalculated;

      var existingQualityRows = readRows_(qualitySheet, qualitySchema);
      var qualityRows = mergeQualityErrors_(existingQualityRows, errors, processedAt, runId);

      if (budget.shouldYield()) {
        return {
          ok: true,
          status: 'in_progress',
          code: 'orders_normalization_budget_reached',
          runId: runId,
          ordersRead: rawOrders.length,
          itemsRead: rawItems.length,
          itemRevenueCalculated: itemRevenueCalculated,
          itemRevenueErrors: itemRevenueErrors,
          processedAt: processedAt
        };
      }

      PRASheetWriter.replaceMany([
        { sheet: stgOrdersSheet, width: stgOrdersSchema.headers.length, rows: stagedOrders },
        { sheet: stgItemsSheet, width: stgItemsSchema.headers.length, rows: stagedItems },
        { sheet: qualitySheet, width: qualitySchema.headers.length, rows: qualityRows }
      ]);

      var unresolvedErrors = qualityRows.filter(function (row) {
        return String(row[0] || '').indexOf(NORMALIZATION_PREFIX) === 0 && !row[6];
      }).length;

      var summary = {
        ok: true,
        status: 'completed',
        code: 'orders_normalization_completed',
        runId: runId,
        ordersRead: rawOrders.length,
        ordersStaged: stagedOrders.length,
        itemsRead: rawItems.length,
        itemsStaged: stagedItems.length,
        itemRevenueCalculated: itemRevenueCalculated,
        itemRevenueErrors: itemRevenueErrors,
        qualityErrors: unresolvedErrors,
        processedAt: processedAt
      };
      PRALogger.info('orders_normalization_completed', {
        runId: runId,
        ordersRead: summary.ordersRead,
        ordersStaged: summary.ordersStaged,
        itemsRead: summary.itemsRead,
        itemsStaged: summary.itemsStaged,
        itemRevenueCalculated: summary.itemRevenueCalculated,
        itemRevenueErrors: summary.itemRevenueErrors,
        qualityErrors: summary.qualityErrors
      });
      return summary;
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({ run: run });
})();
