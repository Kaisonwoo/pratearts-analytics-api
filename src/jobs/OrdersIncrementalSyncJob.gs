var PRAOrdersIncrementalSync = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  var CHECKPOINT_KEY = 'BLING_INCREMENTAL_ORDERS_CHECKPOINT';
  var LAST_RUN_KEY = 'BLING_LAST_INCREMENTAL_ORDERS_RUN';
  var LOOKBACK_KEY = 'BLING_INCREMENTAL_LOOKBACK_DAYS';
  var DEFAULT_LOOKBACK_DAYS = 1;

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function nowIso_() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  }

  function safeDate_(value) {
    var candidate = String(value || '');
    if (!DATE_PATTERN.test(candidate)) return null;
    var parsed = Date.parse(candidate + 'T00:00:00Z');
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10) === candidate ? candidate : null;
  }

  function addDays_(dateValue, days) {
    var parsed = Date.parse(dateValue + 'T00:00:00Z');
    return new Date(parsed + Number(days) * 86400000).toISOString().slice(0, 10);
  }

  function today_(options) {
    var explicit = safeDate_(options && options.today);
    if (explicit) return explicit;
    var timezone = PRAConfig.getPublicValue(
      PRAConfig.KEYS.SYNC_TIMEZONE,
      PRAConfig.DEFAULTS.SYNC_TIMEZONE
    );
    return Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  }

  function readJson_(key) {
    var raw = properties_().getProperty(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
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

  function failure_(code, message, metadata) {
    var result = {
      ok: false,
      status: 'blocked',
      code: code,
      message: message
    };
    Object.keys(metadata || {}).forEach(function (key) {
      if (key !== 'ok' && key !== 'status') result[key] = metadata[key];
    });
    return result;
  }

  function lookbackDays_(options) {
    if (options && typeof options.lookbackDays !== 'undefined') {
      return Number(options.lookbackDays);
    }
    return Number(PRAConfig.getPublicValue(LOOKBACK_KEY, String(DEFAULT_LOOKBACK_DAYS)));
  }

  function validateSettings_(options) {
    var settings = options || {};
    var requestPolicy = PRAConfig.getRequestPolicy();
    var pageSize = Number(settings.pageSize || requestPolicy.pageSize);
    var maxPagesPerRun = Number(settings.maxPagesPerRun || requestPolicy.maxPagesPerRun);
    var lookbackDays = lookbackDays_(settings);

    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return failure_('page_size_invalid', 'O tamanho da página deve estar entre 1 e 100.', {});
    }
    if (!Number.isInteger(maxPagesPerRun) || maxPagesPerRun < 1 || maxPagesPerRun > 100) {
      return failure_(
        'page_budget_invalid',
        'O orçamento de páginas por execução deve estar entre 1 e 100.',
        {}
      );
    }
    if (!Number.isInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 30) {
      return failure_(
        'lookback_invalid',
        'A margem incremental deve estar entre 0 e 30 dias.',
        {}
      );
    }

    return {
      ok: true,
      pageSize: pageSize,
      maxPages: requestPolicy.maxPages,
      maxPagesPerRun: maxPagesPerRun,
      lookbackDays: lookbackDays,
      today: today_(settings)
    };
  }

  function checkpoint_() {
    return readJson_(CHECKPOINT_KEY);
  }

  function saveCheckpoint_(checkpoint) {
    withLock_(function (props) {
      var values = {};
      values[CHECKPOINT_KEY] = JSON.stringify(checkpoint);
      props.setProperties(values, false);
    });
  }

  function clearCheckpoint_() {
    withLock_(function (props) {
      props.deleteProperty(CHECKPOINT_KEY);
    });
  }

  function clearCheckpointAndSaveRun_(summary) {
    withLock_(function (props) {
      props.deleteProperty(CHECKPOINT_KEY);
      var values = {};
      values[LAST_RUN_KEY] = JSON.stringify(summary);
      props.setProperties(values, false);
    });
  }

  function baselineDate_() {
    var lastIncremental = readJson_(LAST_RUN_KEY);
    var incrementalEnd = safeDate_(lastIncremental && lastIncremental.windowEnd);
    if (incrementalEnd) {
      return { source: 'incremental', date: incrementalEnd };
    }

    var lastInitial = readJson_(PRAConfig.KEYS.BLING_LAST_INITIAL_ORDERS_RUN);
    var initialEnd = safeDate_(lastInitial && lastInitial.endDate);
    if (initialEnd) {
      return { source: 'initial_load', date: initialEnd };
    }

    return null;
  }

  function validCheckpoint_(checkpoint) {
    return Boolean(
      checkpoint &&
      checkpoint.runId &&
      safeDate_(checkpoint.windowStart) &&
      safeDate_(checkpoint.windowEnd) &&
      Number.isInteger(Number(checkpoint.pageSize)) &&
      Number(checkpoint.pageSize) >= 1 &&
      Number(checkpoint.pageSize) <= 100 &&
      Number.isInteger(Number(checkpoint.lookbackDays)) &&
      Number(checkpoint.lookbackDays) >= 0 &&
      Number(checkpoint.lookbackDays) <= 30 &&
      Number.isInteger(Number(checkpoint.nextPage)) &&
      Number(checkpoint.nextPage) >= 1
    );
  }

  function newCheckpoint_(settings) {
    var baseline = baselineDate_();
    if (!baseline) return null;
    if (baseline.date > settings.today) {
      return failure_(
        'incremental_baseline_in_future',
        'O último checkpoint confirmado está no futuro em relação à data de execução.',
        { baselineDate: baseline.date }
      );
    }

    return {
      runId: Utilities.getUuid(),
      baselineSource: baseline.source,
      baselineDate: baseline.date,
      windowStart: addDays_(baseline.date, -settings.lookbackDays),
      windowEnd: settings.today,
      lookbackDays: settings.lookbackDays,
      pageSize: settings.pageSize,
      nextPage: 1,
      pagesFetched: 0,
      recordsFetched: 0,
      startedAt: nowIso_(),
      updatedAt: nowIso_()
    };
  }

  function publicSummary_(status, code, checkpoint) {
    return {
      ok: true,
      status: status,
      code: code,
      runId: checkpoint.runId,
      baselineSource: checkpoint.baselineSource,
      windowStart: checkpoint.windowStart,
      windowEnd: checkpoint.windowEnd,
      lookbackDays: checkpoint.lookbackDays,
      pagesFetched: checkpoint.pagesFetched,
      recordsFetched: checkpoint.recordsFetched,
      nextPage: checkpoint.nextPage,
      startedAt: checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt
    };
  }

  function run(options) {
    options = options || {};
    var settings = validateSettings_(options);
    if (!settings.ok) {
      PRALogger.warn('incremental_orders_sync_blocked', { code: settings.code });
      return settings;
    }

    if (options.reset) clearCheckpoint_();

    var current = checkpoint_();
    if (current && !validCheckpoint_(current)) {
      PRALogger.error('incremental_orders_checkpoint_invalid', {});
      return failure_(
        'incremental_checkpoint_invalid',
        'O checkpoint incremental salvo é inválido e precisa ser reiniciado.',
        {}
      );
    }

    if (!current) {
      current = newCheckpoint_(settings);
      if (!current) {
        var missingBaseline = failure_(
          'incremental_baseline_missing',
          'Conclua a carga inicial antes de iniciar a sincronização incremental.',
          {}
        );
        PRALogger.warn('incremental_orders_baseline_missing', {});
        return missingBaseline;
      }
      if (!current.ok && current.status === 'blocked') return current;
      saveCheckpoint_(current);
    }

    var pagesThisRun = 0;
    while (pagesThisRun < settings.maxPagesPerRun) {
      if (current.pagesFetched >= settings.maxPages) {
        PRALogger.error('incremental_orders_page_limit', {
          runId: current.runId,
          pagesFetched: current.pagesFetched
        });
        return failure_(
          'page_limit_reached',
          'A sincronização incremental atingiu o limite seguro de páginas.',
          {
            runId: current.runId,
            pagesFetched: current.pagesFetched,
            recordsFetched: current.recordsFetched,
            nextPage: current.nextPage
          }
        );
      }

      var pageResult = PRABlingClient.get('/pedidos/vendas', {
        dataAlteracaoInicial: current.windowStart,
        dataAlteracaoFinal: current.windowEnd,
        pagina: current.nextPage,
        limite: current.pageSize
      }, { operation: 'sales-orders.incremental' });

      if (!pageResult.ok) {
        PRALogger.warn('incremental_orders_page_failed', {
          runId: current.runId,
          page: current.nextPage,
          statusCode: pageResult.statusCode,
          errorCode: pageResult.error && pageResult.error.code,
          correlationId: pageResult.correlationId
        });
        return failure_(
          'page_fetch_failed',
          'A página incremental não foi carregada; o checkpoint anterior foi preservado.',
          {
            runId: current.runId,
            page: current.nextPage,
            pagesFetched: current.pagesFetched,
            recordsFetched: current.recordsFetched,
            nextPage: current.nextPage,
            correlationId: pageResult.correlationId || ''
          }
        );
      }

      if (!Array.isArray(pageResult.data)) {
        return failure_(
          'response_invalid',
          'A resposta incremental não contém uma lista de pedidos.',
          { runId: current.runId, page: current.nextPage }
        );
      }

      try {
        if (typeof options.onPage === 'function') {
          options.onPage(pageResult.data, current.nextPage, {
            runId: current.runId,
            windowStart: current.windowStart,
            windowEnd: current.windowEnd
          });
        }
      } catch (error) {
        PRALogger.error('incremental_orders_page_persist_failed', {
          runId: current.runId,
          page: current.nextPage
        });
        return failure_(
          'page_persistence_failed',
          'A página foi recebida, mas não foi confirmada pelo armazenamento.',
          {
            runId: current.runId,
            page: current.nextPage,
            pagesFetched: current.pagesFetched,
            recordsFetched: current.recordsFetched,
            nextPage: current.nextPage
          }
        );
      }

      current.pagesFetched += 1;
      current.recordsFetched += pageResult.data.length;
      current.nextPage += 1;
      current.updatedAt = nowIso_();
      pagesThisRun += 1;

      if (pageResult.data.length < current.pageSize) {
        var completed = publicSummary_(
          'completed',
          'incremental_sync_completed',
          current
        );
        clearCheckpointAndSaveRun_(completed);
        PRALogger.info('incremental_orders_sync_completed', {
          runId: current.runId,
          windowStart: current.windowStart,
          windowEnd: current.windowEnd,
          pagesFetched: current.pagesFetched,
          recordsFetched: current.recordsFetched
        });
        return completed;
      }

      saveCheckpoint_(current);
    }

    var inProgress = publicSummary_('in_progress', 'checkpoint_saved', current);
    PRALogger.info('incremental_orders_checkpoint_saved', {
      runId: current.runId,
      pagesFetched: current.pagesFetched,
      recordsFetched: current.recordsFetched,
      nextPage: current.nextPage
    });
    return inProgress;
  }

  return Object.freeze({
    run: run
  });
})();
