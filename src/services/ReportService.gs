var PRAReportService = (function () {
  'use strict';

  var CONTRACT_VERSION = '1.0';
  var DEFAULT_LIMIT = 10;
  var MAX_LIMIT = 50;
  var MAX_RANGE_DAYS = 366;
  var LOCK_TIMEOUT_MS = 10000;

  function text_(value) {
    return value === null || typeof value === 'undefined' ? '' : String(value).trim();
  }

  function number_(value) {
    var candidate = Number(value);
    return Number.isFinite(candidate) ? candidate : 0;
  }

  function money_(value) {
    return Math.round((number_(value) + Number.EPSILON) * 100) / 100;
  }

  function fail_(code, message) {
    var error = new Error(message);
    error.code = code;
    throw error;
  }

  function isoDate_(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
    }
    return text_(value).slice(0, 10);
  }

  function validDate_(value, code) {
    var candidate = Object.prototype.toString.call(value) === '[object Date]'
      ? isoDate_(value) : text_(value);
    var timestamp = Date.parse(candidate + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== candidate) {
      fail_(code, 'Informe uma data válida no formato YYYY-MM-DD.');
    }
    return candidate;
  }

  function timestamp_(value) {
    var parsed = Object.prototype.toString.call(value) === '[object Date]'
      ? value.getTime()
      : Date.parse(text_(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  function addDays_(date, days) {
    var value = new Date(date + 'T00:00:00Z');
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function readTable_(spreadsheet, sheetName) {
    var definition = PRADataLayerSchema.getBySheet(sheetName);
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!definition || !sheet) {
      fail_('report_source_unavailable', 'A fonte analítica ainda não está disponível.');
    }
    var headers = definition.headers;
    if (sheet.getLastRow() < 1) {
      fail_('report_schema_mismatch', 'A estrutura da fonte analítica é incompatível.');
    }
    var actualHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(text_);
    if (JSON.stringify(actualHeaders) !== JSON.stringify(headers)) {
      fail_('report_schema_mismatch', 'A estrutura da fonte analítica é incompatível.');
    }
    var rowCount = Math.max(sheet.getLastRow() - 1, 0);
    if (rowCount === 0) return [];
    return sheet.getRange(2, 1, rowCount, headers.length).getValues()
      .filter(function (row) {
        return row.some(function (cell) { return cell !== '' && cell !== null; });
      })
      .map(function (row) {
        return headers.reduce(function (result, header, index) {
          result[header] = row[index];
          return result;
        }, {});
      });
  }

  function coverage_(periodState) {
    var periods = periodState.map(function (row) { return isoDate_(row.period_key); })
      .filter(function (value) { return /^\d{4}-\d{2}-\d{2}$/.test(value); })
      .sort();
    return {
      startDate: periods.length ? periods[0] : null,
      endDate: periods.length ? periods[periods.length - 1] : null,
      confirmedPeriods: periods.length,
      confirmed: periods.reduce(function (result, period) {
        result[period] = true;
        return result;
      }, Object.create(null))
    };
  }

  function parseFilters_(rawFilters, coverage) {
    var source = rawFilters || {};
    var startDate = text_(source.startDate || source.start);
    var endDate = text_(source.endDate || source.end);
    var view = text_(source.view || source.granularity || 'product').toLowerCase();
    var supplierId = text_(source.supplierId || source.supplier_id);
    var rawLimit = text_(source.limit);

    if (startDate) startDate = validDate_(startDate, 'report_invalid_start_date');
    if (endDate) endDate = validDate_(endDate, 'report_invalid_end_date');
    if (!startDate && coverage.endDate) {
      startDate = addDays_(coverage.endDate, -29);
      if (coverage.startDate > startDate) startDate = coverage.startDate;
    }
    if (!endDate && coverage.endDate) endDate = coverage.endDate;
    if (!startDate && endDate) startDate = endDate;
    if (startDate && !endDate) endDate = startDate;

    if (startDate && endDate) {
      if (startDate > endDate) {
        fail_('report_invalid_date_range', 'A data inicial não pode ser posterior à data final.');
      }
      var rangeDays = Math.floor((Date.parse(endDate + 'T00:00:00Z') -
        Date.parse(startDate + 'T00:00:00Z')) / 86400000) + 1;
      if (rangeDays > MAX_RANGE_DAYS) {
        fail_('report_range_too_large', 'O intervalo máximo permitido é de 366 dias.');
      }
    }
    if (view !== 'product' && view !== 'parent') {
      fail_('report_invalid_view', 'A visualização deve ser product ou parent.');
    }
    if (supplierId && (!/^\d+$/.test(supplierId) || Number(supplierId) < 1)) {
      fail_('report_invalid_supplier', 'O fornecedor informado é inválido.');
    }
    var limit = rawLimit ? Number(rawLimit) : DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      fail_('report_invalid_limit', 'O limite deve ser um inteiro entre 1 e 50.');
    }
    return {
      startDate: startDate || null,
      endDate: endDate || null,
      view: view,
      supplierId: supplierId || null,
      limit: limit
    };
  }

  function inRange_(period, filters, confirmed) {
    var day = isoDate_(period);
    if (!day || !confirmed[day]) return false;
    if (filters.startDate && day < filters.startDate) return false;
    if (filters.endDate && day > filters.endDate) return false;
    return true;
  }

  function buildKpis_(rows) {
    var totals = rows.reduce(function (result, row) {
      result.validOrders += number_(row.valid_orders);
      result.itemsQuantity += number_(row.items_quantity);
      result.revenue += number_(row.revenue);
      return result;
    }, { validOrders: 0, itemsQuantity: 0, revenue: 0 });
    totals.revenue = money_(totals.revenue);
    totals.averageTicket = totals.validOrders > 0
      ? money_(totals.revenue / totals.validOrders)
      : 0;
    return totals;
  }

  function buildTrend_(rows) {
    return rows.slice().sort(function (a, b) {
      return isoDate_(a.period_key).localeCompare(isoDate_(b.period_key));
    }).map(function (row) {
      return {
        period: isoDate_(row.period_key),
        validOrders: number_(row.valid_orders),
        itemsQuantity: number_(row.items_quantity),
        revenue: money_(row.revenue),
        averageTicket: money_(row.average_ticket)
      };
    });
  }

  function productNames_(products) {
    return products.reduce(function (result, row) {
      var id = text_(row.product_id);
      if (id) result[id] = text_(row.name) || text_(row.sku) || ('Produto ' + id);
      return result;
    }, Object.create(null));
  }

  function buildRankings_(rows, products, filters) {
    var names = productNames_(products);
    var groups = Object.create(null);
    var prefix = filters.view + ':';
    rows.forEach(function (row) {
      if (text_(row.mart_key).indexOf(prefix) !== 0) return;
      var supplierId = text_(row.supplier_id);
      if (filters.supplierId && supplierId !== filters.supplierId) return;
      var productId = text_(row.product_id);
      var sku = text_(row.sku);
      var key = [filters.view, productId, sku, supplierId].join(':');
      if (!groups[key]) {
        groups[key] = {
          position: 0,
          view: filters.view,
          productId: productId || null,
          sku: sku || null,
          supplierId: supplierId || null,
          name: names[productId] || sku || 'Produto não identificado',
          quantity: 0,
          revenue: 0,
          ordersCount: 0
        };
      }
      groups[key].quantity += number_(row.quantity);
      groups[key].revenue += number_(row.revenue);
      groups[key].ordersCount += number_(row.orders_count);
    });
    return Object.keys(groups).map(function (key) {
      groups[key].revenue = money_(groups[key].revenue);
      groups[key].quantity = Math.round(groups[key].quantity * 1000000) / 1000000;
      return groups[key];
    }).sort(function (a, b) {
      return b.revenue - a.revenue || b.quantity - a.quantity || a.name.localeCompare(b.name);
    }).slice(0, filters.limit).map(function (row, index) {
      row.position = index + 1;
      return row;
    });
  }

  function buildVariations_(rows, products, filters) {
    var variations = products.reduce(function (result, product) {
      if (String(product.is_variation).toLowerCase() === 'true') {
        result[text_(product.product_id)] = true;
      }
      return result;
    }, Object.create(null));
    return buildRankings_(rows.filter(function (row) {
      return variations[text_(row.product_id)];
    }), products, filters);
  }

  function buildSuppliers_(rows, filters) {
    var groups = Object.create(null);
    rows.forEach(function (row) {
      // The parent view duplicates the product view for reporting purposes.
      if (text_(row.mart_key).indexOf('product:') !== 0) return;
      var supplierId = text_(row.supplier_id);
      if (filters.supplierId && supplierId !== filters.supplierId) return;
      var key = supplierId || '__unassigned__';
      if (!groups[key]) {
        groups[key] = {
          position: 0,
          supplierId: supplierId || null,
          knownProductsCount: 0,
          quantity: 0,
          revenue: 0,
          products: Object.create(null)
        };
      }
      var group = groups[key];
      var productId = text_(row.product_id);
      if (productId) group.products[productId] = true;
      group.quantity += number_(row.quantity);
      group.revenue += number_(row.revenue);
    });
    return Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.knownProductsCount = Object.keys(group.products).length;
      group.quantity = Math.round(group.quantity * 1000000) / 1000000;
      group.revenue = money_(group.revenue);
      delete group.products;
      return group;
    }).sort(function (a, b) {
      return b.revenue - a.revenue || b.quantity - a.quantity ||
        String(a.supplierId || '').localeCompare(String(b.supplierId || ''));
    }).slice(0, filters.limit).map(function (row, index) {
      row.position = index + 1;
      return row;
    });
  }

  function groupCounts_(rows, field, fallback) {
    var counts = rows.reduce(function (result, row) {
      var key = text_(row[field]) || fallback;
      result[key] = (result[key] || 0) + 1;
      return result;
    }, Object.create(null));
    return Object.keys(counts).sort().map(function (key) {
      return { code: key, count: counts[key] };
    });
  }

  function buildQuality_(errors, windows) {
    var unresolved = errors.filter(function (row) { return !timestamp_(row.resolved_at); });
    var pendingWindows = windows.filter(function (row) {
      return ['completed', 'cancelled'].indexOf(text_(row.status).toLowerCase()) < 0;
    });
    return {
      totalErrors: errors.length,
      unresolvedErrors: unresolved.length,
      errorsByCode: groupCounts_(unresolved, 'error_code', 'unknown'),
      errorsBySeverity: groupCounts_(unresolved, 'severity', 'unknown'),
      recalculationWindows: windows.length,
      pendingWindows: pendingWindows.length,
      windowsByStatus: groupCounts_(windows, 'status', 'unknown')
    };
  }

  function triggerSummary_() {
    if (typeof ScriptApp === 'undefined' || !ScriptApp.getProjectTriggers) {
      return { installed: null, handlers: [] };
    }
    var handlers = ScriptApp.getProjectTriggers().map(function (trigger) {
      return text_(trigger.getHandlerFunction());
    }).filter(function (handler) {
      return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(handler);
    });
    return { installed: handlers.length, handlers: handlers.sort() };
  }

  function buildOperations_(syncRuns, periodState) {
    var latestSync = syncRuns.slice().sort(function (a, b) {
      return (timestamp_(b.started_at) || '').localeCompare(timestamp_(a.started_at) || '');
    })[0];
    var latestCalculation = periodState.map(function (row) {
      return timestamp_(row.calculated_at);
    }).filter(Boolean).sort().pop() || null;
    return {
      latestCalculationAt: latestCalculation,
      latestSync: latestSync ? {
        jobName: text_(latestSync.job_name) || null,
        status: text_(latestSync.status) || null,
        startedAt: timestamp_(latestSync.started_at),
        finishedAt: timestamp_(latestSync.finished_at),
        durationMs: number_(latestSync.duration_ms),
        recordsProcessed: number_(latestSync.records_processed),
        errorCode: text_(latestSync.error_code) || null
      } : null,
      triggers: triggerSummary_()
    };
  }

  function runtimeMetadata_() {
    if (typeof PRA_RUNTIME_METADATA === 'undefined') {
      return { revision: null, sourceHash: null };
    }
    return {
      revision: text_(PRA_RUNTIME_METADATA.revision) || null,
      sourceHash: text_(PRA_RUNTIME_METADATA.sourceHash) || null
    };
  }

  function publicFilters_(filters) {
    var source = filters || {};
    return {
      startDate: text_(source.startDate || source.start).slice(0, 10) || null,
      endDate: text_(source.endDate || source.end).slice(0, 10) || null,
      view: text_(source.view || source.granularity || 'product').slice(0, 20),
      supplierId: text_(source.supplierId || source.supplier_id).slice(0, 40) || null,
      limit: text_(source.limit).slice(0, 4) || String(DEFAULT_LIMIT)
    };
  }

  function errorEnvelope(code, message, filters) {
    return {
      data: null,
      meta: {
        contractVersion: CONTRACT_VERSION,
        generatedAt: new Date().toISOString(),
        schemaVersion: PRADataLayerSchema.VERSION,
        source: 'confirmed_marts'
      },
      filtersApplied: publicFilters_(filters),
      errors: [{ code: code, message: message }]
    };
  }

  function appliedFiltersFor_(filters, resource) {
    if (resource === 'kpis' || resource === 'trend') {
      return { startDate: filters.startDate, endDate: filters.endDate };
    }
    return filters;
  }

  function executeInternal_(filters, resource) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      return errorEnvelope(
        'report_source_busy',
        'Os indicadores estão sendo atualizados. Tente novamente em instantes.',
        filters
      );
    }
    try {
      var spreadsheetId = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var periodState = readTable_(spreadsheet, 'mart_period_state');
      var coverage = coverage_(periodState);
      var applied = parseFilters_(filters, coverage);
      var requested = filters || {};
      if ((resource === 'kpis' || resource === 'trend') &&
          (text_(requested.supplierId || requested.supplier_id) ||
            text_(requested.view || requested.granularity) || text_(requested.limit))) {
        fail_('report_filter_unsupported',
          'Este recurso aceita somente filtros de período.');
      }
      if (applied.view !== 'product' &&
          (resource === 'variations' || resource === 'suppliers')) {
        fail_('report_invalid_view', 'Esta consulta requer a visualização product.');
      }
      var needsKpis = resource === 'dashboard' || resource === 'kpis' || resource === 'trend';
      var needsSales = resource === 'dashboard' || resource === 'products' ||
        resource === 'variations' || resource === 'suppliers';
      var kpiRows = needsKpis ? readTable_(spreadsheet, 'mart_kpis').filter(function (row) {
        return inRange_(row.period_key, applied, coverage.confirmed);
      }) : [];
      var salesRows = needsSales ? readTable_(spreadsheet, 'mart_product_sales').filter(function (row) {
        return inRange_(row.period_key, applied, coverage.confirmed);
      }) : [];
      var products = resource === 'dashboard' || resource === 'products' || resource === 'variations'
        ? readTable_(spreadsheet, 'stg_products') : [];
      var data;
      if (resource === 'dashboard') {
        data = {
          kpis: buildKpis_(kpiRows),
          trend: buildTrend_(kpiRows),
          rankings: buildRankings_(salesRows, products, applied),
          quality: buildQuality_(readTable_(spreadsheet, 'data_quality_errors'),
            readTable_(spreadsheet, 'recalc_windows')),
          operations: buildOperations_(readTable_(spreadsheet, 'sync_runs'), periodState)
        };
      } else if (resource === 'kpis') {
        data = { kpis: buildKpis_(kpiRows) };
      } else if (resource === 'trend') {
        data = { trend: buildTrend_(kpiRows) };
      } else if (resource === 'products') {
        data = { products: buildRankings_(salesRows, products, applied) };
      } else if (resource === 'variations') {
        data = { variations: buildVariations_(salesRows, products, applied) };
      } else if (resource === 'suppliers') {
        data = { suppliers: buildSuppliers_(salesRows, applied) };
      }

      return {
        data: data,
        meta: {
          contractVersion: CONTRACT_VERSION,
          generatedAt: new Date().toISOString(),
          schemaVersion: PRADataLayerSchema.VERSION,
          source: 'confirmed_marts',
          coverage: {
            startDate: coverage.startDate,
            endDate: coverage.endDate,
            confirmedPeriods: coverage.confirmedPeriods
          },
          supplierAssignment: 'current_not_historical',
          runtime: runtimeMetadata_()
        },
        filtersApplied: appliedFiltersFor_(applied, resource),
        errors: []
      };
    } catch (error) {
      var known = /^report_[a-z0-9_]+$/.test(text_(error && error.code));
      var code = known ? text_(error.code) : 'report_internal_error';
      var message = known ? text_(error.message) : 'Não foi possível consultar os indicadores.';
      if (typeof PRALogger !== 'undefined') {
        PRALogger.warn('report_request_failed', { code: code });
      }
      return errorEnvelope(code, message, filters);
    } finally {
      lock.releaseLock();
    }
  }

  function execute(filters) {
    return executeInternal_(filters, 'dashboard');
  }

  function executeResource(resource, filters) {
    if (['kpis', 'trend', 'products', 'variations', 'suppliers'].indexOf(resource) < 0) {
      return errorEnvelope('report_unknown_resource', 'O recurso solicitado não existe.', filters);
    }
    return executeInternal_(filters, resource);
  }

  return Object.freeze({
    execute: execute,
    executeResource: executeResource,
    errorEnvelope: errorEnvelope
  });
})();
