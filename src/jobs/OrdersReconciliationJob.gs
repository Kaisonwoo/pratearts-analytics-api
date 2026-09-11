var PRAOrdersReconciliationJob = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var CHECKPOINT_KEY = 'BLING_RECONCILIATION_CHECKPOINT';
  var LAST_RUN_KEY = 'BLING_LAST_RECONCILIATION_RUN';
  var WINDOW_DAYS_KEY = 'BLING_RECONCILIATION_WINDOW_DAYS';
  var FREQUENCY_DAYS_KEY = 'BLING_RECONCILIATION_FREQUENCY_DAYS';
  var DEFAULT_WINDOW_DAYS = 30;
  var DEFAULT_FREQUENCY_DAYS = 7;
  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function withLock_(callback) {
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      return callback(properties_());
    } finally {
      lock.releaseLock();
    }
  }

  function readJson_(key) {
    var raw = properties_().getProperty(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  }

  function nowIso_() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  }

  function validDate_(value) {
    var text = String(value || '');
    if (!DATE_PATTERN.test(text)) return null;
    var timestamp = Date.parse(text + 'T00:00:00Z');
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString().slice(0, 10) === text ? text : null;
  }

  function addDays_(dateValue, days) {
    return new Date(
      Date.parse(dateValue + 'T00:00:00Z') + Number(days) * 86400000
    ).toISOString().slice(0, 10);
  }

  function daysBetween_(left, right) {
    return Math.floor(
      (Date.parse(right + 'T00:00:00Z') - Date.parse(left + 'T00:00:00Z')) / 86400000
    );
  }

  function today_(options) {
    var explicit = validDate_(options && options.today);
    if (explicit) return explicit;
    var timezone = PRAConfig.getPublicValue(
      PRAConfig.KEYS.SYNC_TIMEZONE,
      PRAConfig.DEFAULTS.SYNC_TIMEZONE
    );
    return Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  }

  function publicInteger_(key, fallback) {
    return Number(PRAConfig.getPublicValue(key, String(fallback)));
  }

  function failure_(code, message, metadata) {
    var result = { ok: false, status: 'blocked', code: code, message: message };
    Object.keys(metadata || {}).forEach(function (key) { result[key] = metadata[key]; });
    return result;
  }

  function settings_(options) {
    options = options || {};
    var requestPolicy = PRAConfig.getRequestPolicy();
    var pageSize = Number(options.pageSize || requestPolicy.pageSize);
    var maxPagesPerRun = Number(options.maxPagesPerRun || requestPolicy.maxPagesPerRun);
    var windowDays = typeof options.windowDays !== 'undefined'
      ? Number(options.windowDays)
      : publicInteger_(WINDOW_DAYS_KEY, DEFAULT_WINDOW_DAYS);
    var frequencyDays = typeof options.frequencyDays !== 'undefined'
      ? Number(options.frequencyDays)
      : publicInteger_(FREQUENCY_DAYS_KEY, DEFAULT_FREQUENCY_DAYS);

    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      return failure_('reconciliation_window_invalid', 'A janela deve estar entre 1 e 365 dias.', {});
    }
    if (!Number.isInteger(frequencyDays) || frequencyDays < 1 || frequencyDays > 90) {
      return failure_('reconciliation_frequency_invalid', 'A frequência deve estar entre 1 e 90 dias.', {});
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return failure_('page_size_invalid', 'O tamanho da página deve estar entre 1 e 100.', {});
    }
    if (!Number.isInteger(maxPagesPerRun) || maxPagesPerRun < 1 || maxPagesPerRun > 100) {
      return failure_('page_budget_invalid', 'O orçamento de páginas deve estar entre 1 e 100.', {});
    }

    return {
      ok: true,
      today: today_(options),
      windowDays: windowDays,
      frequencyDays: frequencyDays,
      pageSize: pageSize,
      maxPages: requestPolicy.maxPages,
      maxPagesPerRun: maxPagesPerRun
    };
  }

  function saveCheckpoint_(checkpoint) {
    withLock_(function (props) {
      var values = {};
      values[CHECKPOINT_KEY] = JSON.stringify(checkpoint);
      props.setProperties(values, false);
    });
  }

  function clearCheckpoint_() {
    withLock_(function (props) { props.deleteProperty(CHECKPOINT_KEY); });
  }

  function complete_(checkpoint) {
    var summary = {
      ok: true,
      status: 'completed',
      code: 'reconciliation_completed',
      runId: checkpoint.runId,
      windowStart: checkpoint.windowStart,
      windowEnd: checkpoint.windowEnd,
      windowDays: checkpoint.windowDays,
      frequencyDays: checkpoint.frequencyDays,
      pagesFetched: checkpoint.pagesFetched,
      recordsFetched: checkpoint.recordsFetched,
      recalcMarked: true,
      startedAt: checkpoint.startedAt,
      finishedAt: nowIso_()
    };
    withLock_(function (props) {
      props.deleteProperty(CHECKPOINT_KEY);
      var values = {};
      values[LAST_RUN_KEY] = JSON.stringify(summary);
      props.setProperties(values, false);
    });
    return summary;
  }

  function validCheckpoint_(checkpoint) {
    return Boolean(
      checkpoint && checkpoint.runId &&
      (checkpoint.phase === 'fetch' || checkpoint.phase === 'mark') &&
      validDate_(checkpoint.windowStart) && validDate_(checkpoint.windowEnd) &&
      Number.isInteger(Number(checkpoint.nextPage)) && Number(checkpoint.nextPage) >= 1 &&
      Number.isInteger(Number(checkpoint.pageSize)) && Number(checkpoint.pageSize) >= 1
    );
  }

  function shouldSkip_(settings, force) {
    if (force) return null;
    var lastRun = readJson_(LAST_RUN_KEY);
    var lastEnd = validDate_(lastRun && lastRun.windowEnd);
    if (!lastEnd || lastEnd > settings.today) return null;
    var elapsed = daysBetween_(lastEnd, settings.today);
    if (elapsed >= settings.frequencyDays) return null;
    return {
      ok: true,
      status: 'skipped',
      code: 'reconciliation_not_due',
      lastWindowEnd: lastEnd,
      nextEligibleDate: addDays_(lastEnd, settings.frequencyDays),
      frequencyDays: settings.frequencyDays
    };
  }

  function newCheckpoint_(settings) {
    return {
      runId: Utilities.getUuid(),
      phase: 'fetch',
      windowStart: addDays_(settings.today, -(settings.windowDays - 1)),
      windowEnd: settings.today,
      windowDays: settings.windowDays,
      frequencyDays: settings.frequencyDays,
      pageSize: settings.pageSize,
      nextPage: 1,
      pagesFetched: 0,
      recordsFetched: 0,
      startedAt: nowIso_(),
      updatedAt: nowIso_()
    };
  }

  function markRecalculation_(checkpoint) {
    try {
      PRARecalculationWindowStore.markWindow(
        checkpoint.windowStart,
        checkpoint.windowEnd,
        'historical_reconciliation',
        checkpoint.runId
      );
      return null;
    } catch (error) {
      PRALogger.error('reconciliation_recalc_mark_failed', { runId: checkpoint.runId });
      return failure_(
        'recalc_mark_failed',
        'A janela foi coletada, mas não foi possível marcar o recálculo.',
        {
          runId: checkpoint.runId,
          windowStart: checkpoint.windowStart,
          windowEnd: checkpoint.windowEnd,
          phase: 'mark'
        }
      );
    }
  }

  function run(options) {
    options = options || {};
    var settings = settings_(options);
    if (!settings.ok) return settings;
    if (options.reset) clearCheckpoint_();

    var checkpoint = readJson_(CHECKPOINT_KEY);
    if (checkpoint && !validCheckpoint_(checkpoint)) {
      return failure_(
        'reconciliation_checkpoint_invalid',
        'O checkpoint de reconciliação salvo é inválido e precisa ser reiniciado.',
        {}
      );
    }

    if (!checkpoint) {
      var skipped = shouldSkip_(settings, Boolean(options.force));
      if (skipped) return skipped;
      checkpoint = newCheckpoint_(settings);
      saveCheckpoint_(checkpoint);
    }

    if (checkpoint.phase === 'mark') {
      var retryMarkFailure = markRecalculation_(checkpoint);
      if (retryMarkFailure) return retryMarkFailure;
      return complete_(checkpoint);
    }

    var pagesThisRun = 0;
    while (pagesThisRun < settings.maxPagesPerRun) {
      if (checkpoint.pagesFetched >= settings.maxPages) {
        return failure_(
          'page_limit_reached',
          'A reconciliação atingiu o limite seguro de páginas.',
          { runId: checkpoint.runId, nextPage: checkpoint.nextPage }
        );
      }

      var pageResult = PRABlingClient.get('/pedidos/vendas', {
        dataInicial: checkpoint.windowStart,
        dataFinal: checkpoint.windowEnd,
        pagina: checkpoint.nextPage,
        limite: checkpoint.pageSize
      }, { operation: 'sales-orders.historical-reconciliation' });

      if (!pageResult.ok) {
        return failure_(
          'page_fetch_failed',
          'A página de reconciliação não foi carregada; o checkpoint foi preservado.',
          {
            runId: checkpoint.runId,
            page: checkpoint.nextPage,
            correlationId: pageResult.correlationId || ''
          }
        );
      }
      if (!Array.isArray(pageResult.data)) {
        return failure_(
          'response_invalid',
          'A resposta de reconciliação não contém uma lista de pedidos.',
          { runId: checkpoint.runId, page: checkpoint.nextPage }
        );
      }

      try {
        if (typeof options.onPage === 'function') {
          options.onPage(pageResult.data, checkpoint.nextPage, {
            runId: checkpoint.runId,
            reconciliation: true,
            windowStart: checkpoint.windowStart,
            windowEnd: checkpoint.windowEnd
          });
        }
      } catch (error) {
        return failure_(
          'page_persistence_failed',
          'A página foi recebida, mas não foi confirmada pela fila de detalhes.',
          { runId: checkpoint.runId, page: checkpoint.nextPage, nextPage: checkpoint.nextPage }
        );
      }

      checkpoint.pagesFetched += 1;
      checkpoint.recordsFetched += pageResult.data.length;
      checkpoint.nextPage += 1;
      checkpoint.updatedAt = nowIso_();
      pagesThisRun += 1;

      if (pageResult.data.length < checkpoint.pageSize) {
        checkpoint.phase = 'mark';
        saveCheckpoint_(checkpoint);
        var markFailure = markRecalculation_(checkpoint);
        if (markFailure) return markFailure;
        var completed = complete_(checkpoint);
        PRALogger.info('orders_reconciliation_completed', {
          runId: checkpoint.runId,
          windowStart: checkpoint.windowStart,
          windowEnd: checkpoint.windowEnd,
          pagesFetched: checkpoint.pagesFetched,
          recordsFetched: checkpoint.recordsFetched
        });
        return completed;
      }

      saveCheckpoint_(checkpoint);
    }

    return {
      ok: true,
      status: 'in_progress',
      code: 'reconciliation_checkpoint_saved',
      runId: checkpoint.runId,
      windowStart: checkpoint.windowStart,
      windowEnd: checkpoint.windowEnd,
      pagesFetched: checkpoint.pagesFetched,
      recordsFetched: checkpoint.recordsFetched,
      nextPage: checkpoint.nextPage
    };
  }

  return Object.freeze({ run: run });
})();
