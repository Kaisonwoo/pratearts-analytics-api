var PRAMartsJob = (function () {
  'use strict';

  var HANDLER = 'runMartsContinuation';
  var CHECKPOINTS = ['BLING_INITIAL_ORDERS_CHECKPOINT', 'BLING_INCREMENTAL_ORDERS_CHECKPOINT',
    'BLING_RECONCILIATION_CHECKPOINT', 'BLING_PRODUCTS_SYNC_CHECKPOINT',
    'BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT'];
  var INPUTS = ['raw_orders', 'raw_order_items', 'raw_products', 'stg_orders',
    'stg_order_items', 'stg_product_suppliers', 'order_detail_errors', 'data_quality_errors'];
  var OUTPUTS = ['stg_products', 'mart_kpis', 'mart_product_sales', 'mart_period_state', 'recalc_windows'];

  function result(status, code, extra) {
    var summary = { ok: status !== 'blocked', status: status, code: code,
      periodsWritten: 0, periodsRemaining: 0, windowsCompleted: 0 };
    Object.keys(extra || {}).forEach(function (key) { summary[key] = extra[key]; });
    return summary;
  }

  function read(spreadsheet, name) {
    var schema = PRADataLayerSchema.getBySheet(name);
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet || sheet.getLastRow() === 0) PRAMartService.fail('mart_schema_not_provisioned');
    var width = schema.headers.length;
    var header = sheet.getRange(1, 1, 1, width).getValues()[0];
    if (JSON.stringify(header) !== JSON.stringify(schema.headers)) PRAMartService.fail('mart_schema_mismatch');
    var count = sheet.getLastRow() - 1;
    var rows = count > 0 ? sheet.getRange(2, 1, count, width).getValues().filter(function (row) {
      return row.some(function (cell) { return cell !== '' && cell !== null; });
    }) : [];
    // Sheets may return typed Date cells for period keys and boundaries.
    rows.forEach(function (row) {
      schema.headers.forEach(function (field, col) {
        if (['period_key', 'period_start', 'period_end', 'window_start', 'window_end'].indexOf(field) >= 0) {
          row[col] = PRAMartService.date(row[col]);
        }
      });
    });
    return { sheet: sheet, width: width, rows: rows, objects: rows.map(function (row) {
      var item = {};
      schema.headers.forEach(function (field, col) { item[field] = row[col]; });
      return item;
    }) };
  }

  function upstreamPending() {
    var props = PropertiesService.getScriptProperties();
    if (CHECKPOINTS.some(function (key) { return Boolean(props.getProperty(key)); })) return true;
    var raw = props.getProperty('BLING_ORDER_DETAILS_QUEUE_INDEX');
    if (!raw) return false;
    try {
      var index = JSON.parse(raw);
      if (index.version !== 1 || !Array.isArray(index.shards)) throw new Error('invalid queue');
      return index.shards.some(function (key) {
        var shard = JSON.parse(props.getProperty(key));
        if (!shard || !Array.isArray(shard.entries)) throw new Error('invalid shard');
        return shard.entries.length > 0;
      });
    } catch (error) { PRAMartService.fail('mart_queue_state_invalid'); }
  }

  function groupBy(rows, column) {
    var grouped = Object.create(null);
    rows.forEach(function (row) {
      var key = PRAMartService.text(row[column]);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(row);
    });
    return grouped;
  }
  function operation(target, rows) { return { sheet: target.sheet, width: target.width, rows: rows }; }
  function persist(operations) {
    // Expand the grid before writing; never delete rows or previous values.
    operations.forEach(function (item) {
      var available = item.sheet.getMaxRows();
      var required = item.rows.length + 1;
      if (required > available) item.sheet.insertRowsAfter(available, required - available);
    });
    return PRASheetWriter.replaceMany(operations);
  }
  function replaceDays(rows, col, selected, additions) {
    return rows.filter(function (row) { return !selected[row[col]]; }).concat(additions)
      .sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : (String(a[0]) > String(b[0]) ? 1 : 0); });
  }

  function runLocked(options, budget) {
    if (upstreamPending()) return result('blocked', 'mart_upstream_pending');
    if (budget.shouldYield()) return result('in_progress', 'mart_budget_reached');
    var id = PRAConfig.requirePublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID);
    var attended = PRAMartService.text(PRAConfig.requirePublicValue(PRAConfig.KEYS.BLING_STATUS_ATENDIDO_ID));
    if (!/^\d+$/.test(attended) || Number(attended) < 1) PRAMartService.fail('mart_invalid_attended_status');
    var spreadsheet = SpreadsheetApp.openById(id);
    var tables = {};
    INPUTS.concat(OUTPUTS).forEach(function (name) { tables[name] = read(spreadsheet, name); });
    if (tables.order_detail_errors.objects.some(function (error) { return !error.resolved_at; }) ||
        tables.data_quality_errors.objects.some(function (error) {
          return !error.resolved_at && String(error.error_key).indexOf('normalization:') === 0 &&
            error.severity === 'error';
        })) return result('blocked', 'mart_quality_blocked');

    var windows = tables.recalc_windows.objects;
    if (windows.some(function (window) { return window.status === 'waiting_details'; })) {
      return result('blocked', 'mart_upstream_pending');
    }
    windows.forEach(function (window) {
      if (window.window_start > window.window_end || ['pending', 'completed'].indexOf(window.status) < 0) {
        PRAMartService.fail('mart_invalid_window');
      }
    });
    var prepared = PRAMartService.prepare(INPUTS.reduce(function (data, name) {
      data[name] = tables[name].objects; return data;
    }, {}), attended);
    var kpisByDay = groupBy(tables.mart_kpis.rows, 0);
    var salesByDay = groupBy(tables.mart_product_sales.rows, 1);
    var stateByDay = groupBy(tables.mart_period_state.rows, 0);
    var periodSet = Object.create(null);
    [prepared.days, kpisByDay, salesByDay, stateByDay].forEach(function (group) {
      Object.keys(group).forEach(function (day) { periodSet[PRAMartService.date(day)] = true; });
    });
    var dates = Object.keys(periodSet).sort();
    var dirty = [];
    var fingerprints = {};
    dates.forEach(function (day) {
      var revisions = windows.filter(function (window) {
        return window.window_start <= day && window.window_end >= day;
      }).map(function (window) { return [window.recalc_key, String(window.marked_at), window.run_id]; });
      var signature = prepared.days[day] ? prepared.days[day].signature : [];
      var sourceHash = PRAMartService.hash(['mart-v1', signature, PRAMartService.sorted(revisions)]);
      fingerprints[day] = sourceHash;
      var states = stateByDay[day] || [];
      var currentOutput = PRAMartService.outputHash(kpisByDay[day] || [], salesByDay[day] || []);
      if (states.length !== 1 || states[0][1] !== sourceHash || states[0][2] !== currentOutput) dirty.push(day);
    });
    if (budget.shouldYield()) return result('in_progress', 'mart_budget_reached', { periodsRemaining: dirty.length });

    var selected = Object.create(null);
    var newKpis = []; var newSales = []; var newState = [];
    var runId = Utilities.getUuid(); var calculatedAt = new Date().toISOString();
    var missing = 0; var multiple = 0;
    for (var i = 0; i < Math.min(dirty.length, options.maxPeriodsPerRun); i += 1) {
      if (budget.shouldYield()) break;
      var day = dirty[i];
      var built = PRAMartService.buildDay(day, prepared.days[day], calculatedAt, runId);
      selected[day] = true;
      newKpis = newKpis.concat(built.kpis);
      newSales = newSales.concat(built.sales);
      newState.push([day, fingerprints[day], PRAMartService.outputHash(built.kpis, built.sales), calculatedAt, runId]);
      missing += built.missingSupplierItems; multiple += built.multipleSupplierItems;
    }
    // Do not start remote writes after the safe margin. Nothing has changed yet.
    if (budget.shouldYield()) return result('in_progress', 'mart_budget_reached', { periodsRemaining: dirty.length });
    var remaining = dirty.filter(function (day) { return !selected[day]; });
    var completedWindows = 0;
    var markerRows = tables.recalc_windows.rows.map(function (row) {
      var next = row.slice();
      if (row[4] === 'pending' && !remaining.some(function (day) { return day >= row[1] && day <= row[2]; })) {
        next[4] = 'completed'; completedWindows += 1;
      }
      return next;
    });
    var productRows = prepared.products.map(function (row) { return row.concat([calculatedAt, runId]); });
    var oldProducts = tables.stg_products.rows.map(function (row) { return row.slice(0, 7); });
    var productsChanged = PRAMartService.hash(PRAMartService.sorted(oldProducts)) !==
      PRAMartService.hash(PRAMartService.sorted(prepared.products));
    var operations = [];
    if (productsChanged) operations.push(operation(tables.stg_products, productRows));
    if (newState.length) {
      operations.push(operation(tables.mart_kpis, replaceDays(tables.mart_kpis.rows, 0, selected, newKpis)));
      operations.push(operation(tables.mart_product_sales, replaceDays(tables.mart_product_sales.rows, 1, selected, newSales)));
    }
    // Flush both marts before saving their integrity state. A hard interruption is
    // detected by the source/output hashes on the next run, even if rollback cannot run.
    if (operations.length) persist(operations);
    if (newState.length || completedWindows) {
      SpreadsheetApp.flush();
      var commits = [];
      if (newState.length) commits.push(operation(tables.mart_period_state,
        replaceDays(tables.mart_period_state.rows, 0, selected, newState)));
      if (completedWindows) commits.push(operation(tables.recalc_windows, markerRows));
      persist(commits);
      SpreadsheetApp.flush();
    }
    return result(remaining.length ? 'in_progress' : 'completed',
      remaining.length ? 'mart_batch_completed' : 'marts_completed', {
        runId: runId, periodsWritten: newState.length, periodsRemaining: remaining.length,
        windowsCompleted: completedWindows, productRowsWritten: newSales.length,
        missingSupplierItems: missing, multipleSupplierItems: multiple
      });
  }

  function run(options) {
    options = options || {};
    var limit = Number(options.maxPeriodsPerRun || 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 366) PRAMartService.fail('mart_invalid_batch_limit');
    options.maxPeriodsPerRun = limit;
    var policy = PRAConfig.getRequestPolicy();
    var budget = PRARuntimeBudget.create({ budgetMs: options.maxRuntimeMs || policy.executionBudgetMs || 270000,
      deadlineAtMs: options.deadlineAtMs, reserveMs: options.reserveMs == null ? 30000 : options.reserveMs });
    var summary;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Math.min(30000, budget.remainingMs()))) {
      summary = result('in_progress', 'mart_execution_busy');
    } else {
      try { summary = runLocked(options, budget); }
      catch (error) {
        var code = String(error.code || 'mart_storage_failed');
        if (!/^(mart_|sheet_write_)/.test(code)) code = 'mart_storage_failed';
        summary = result('blocked', code);
      } finally { lock.releaseLock(); }
    }
    if (options.scheduleContinuation !== false) {
      try {
        var scheduled = summary.status === 'in_progress'
          ? PRAContinuationScheduler.schedule(HANDLER, 60000, { replaceExisting: Boolean(options.replaceContinuation) })
          : PRAContinuationScheduler.cancel(HANDLER);
        summary.continuationScheduled = Boolean(scheduled.scheduled);
      } catch (error) { summary = result('blocked', 'mart_continuation_failed'); }
    }
    PRALogger.info('marts_finished', summary);
    return summary;
  }
  return Object.freeze({ run: run });
})();
