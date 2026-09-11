var PRAOrdersInitialLoad = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
    var normalized = new Date(parsed).toISOString().slice(0, 10);
    return normalized === candidate ? candidate : null;
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

  function validate_(options) {
    var settings = options || {};
    var startDate = safeDate_(settings.startDate);
    var endDate = safeDate_(settings.endDate);
    if (!startDate || !endDate) {
      return failure_(
        'period_invalid',
        'Informe startDate e endDate no formato YYYY-MM-DD.',
        {}
      );
    }
    if (startDate > endDate) {
      return failure_(
        'period_invalid',
        'O início do período não pode ser posterior ao fim.',
        {}
      );
    }

    var statusId = settings.statusId ||
      PRAConfig.getPublicValue(PRAConfig.KEYS.BLING_STATUS_ATENDIDO_ID, null);
    if (!/^\d+$/.test(String(statusId || '')) || Number(statusId) < 1) {
      return failure_(
        'status_configuration_missing',
        'Configure o ID da situação Atendido antes da carga inicial.',
        {}
      );
    }

    var policy = PRAConfig.getRequestPolicy();
    var pageSize = Number(settings.pageSize || policy.pageSize);
    var maxPagesPerRun = Number(settings.maxPagesPerRun || policy.maxPagesPerRun);
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

    return {
      ok: true,
      startDate: startDate,
      endDate: endDate,
      statusId: String(statusId),
      pageSize: pageSize,
      maxPages: policy.maxPages,
      maxPagesPerRun: maxPagesPerRun,
      fingerprint: [startDate, endDate, String(statusId), pageSize].join('|')
    };
  }

  function newCheckpoint_(settings) {
    return {
      runId: Utilities.getUuid(),
      fingerprint: settings.fingerprint,
      startDate: settings.startDate,
      endDate: settings.endDate,
      statusId: settings.statusId,
      pageSize: settings.pageSize,
      nextPage: 1,
      pagesFetched: 0,
      recordsFetched: 0,
      startedAt: nowIso_(),
      updatedAt: nowIso_()
    };
  }

  function checkpoint_() {
    return readJson_(PRAConfig.KEYS.BLING_INITIAL_ORDERS_CHECKPOINT);
  }

  function saveCheckpoint_(checkpoint) {
    withLock_(function (props) {
      var values = {};
      values[PRAConfig.KEYS.BLING_INITIAL_ORDERS_CHECKPOINT] = JSON.stringify(checkpoint);
      props.setProperties(values, false);
    });
  }

  function clearCheckpointAndSaveRun_(summary) {
    withLock_(function (props) {
      props.deleteProperty(PRAConfig.KEYS.BLING_INITIAL_ORDERS_CHECKPOINT);
      var values = {};
      values[PRAConfig.KEYS.BLING_LAST_INITIAL_ORDERS_RUN] = JSON.stringify(summary);
      props.setProperties(values, false);
    });
  }

  function publicSummary_(status, code, checkpoint, startedAt) {
    return {
      ok: true,
      status: status,
      code: code,
      runId: checkpoint.runId,
      startDate: checkpoint.startDate,
      endDate: checkpoint.endDate,
      statusId: checkpoint.statusId,
      pagesFetched: checkpoint.pagesFetched,
      recordsFetched: checkpoint.recordsFetched,
      nextPage: checkpoint.nextPage,
      startedAt: startedAt || checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt
    };
  }

  function run(options) {
    options = options || {};
    var settings = validate_(options);
    if (!settings.ok) {
      PRALogger.warn('initial_orders_load_blocked', { code: settings.code });
      return settings;
    }

    var current = checkpoint_();
    if (options && options.reset) {
      current = null;
      withLock_(function (props) {
        props.deleteProperty(PRAConfig.KEYS.BLING_INITIAL_ORDERS_CHECKPOINT);
      });
    }
    if (!current || current.fingerprint !== settings.fingerprint) {
      current = newCheckpoint_(settings);
      saveCheckpoint_(current);
    }

    var startedAt = current.startedAt;
    var pagesThisRun = 0;
    while (pagesThisRun < settings.maxPagesPerRun) {
      if (current.pagesFetched >= settings.maxPages) {
        var limited = failure_(
          'page_limit_reached',
          'A carga atingiu o limite seguro de páginas.',
          publicSummary_('blocked', 'page_limit_reached', current, startedAt)
        );
        PRALogger.error('initial_orders_load_page_limit', {
          runId: current.runId,
          pagesFetched: current.pagesFetched
        });
        return limited;
      }

      var pageResult = PRABlingClient.get('/pedidos/vendas', {
        'idsSituacoes[]': current.statusId,
        dataInicial: current.startDate,
        dataFinal: current.endDate,
        pagina: current.nextPage,
        limite: current.pageSize
      }, { operation: 'sales-orders.initial-load' });

      if (!pageResult.ok) {
        PRALogger.warn('initial_orders_load_page_failed', {
          runId: current.runId,
          page: current.nextPage,
          statusCode: pageResult.statusCode,
          errorCode: pageResult.error.code,
          correlationId: pageResult.correlationId
        });
        return failure_(
          'page_fetch_failed',
          'A página não foi carregada; o checkpoint anterior foi preservado.',
          {
            runId: current.runId,
            page: current.nextPage,
            statusCode: pageResult.statusCode,
            errorCode: pageResult.error.code,
            correlationId: pageResult.correlationId,
            pagesFetched: current.pagesFetched,
            recordsFetched: current.recordsFetched,
            nextPage: current.nextPage
          }
        );
      }
      if (!Array.isArray(pageResult.data)) {
        return failure_(
          'response_invalid',
          'A resposta da página não contém uma lista de pedidos.',
          { runId: current.runId, page: current.nextPage }
        );
      }

      try {
        if (typeof options.onPage === 'function') {
          options.onPage(pageResult.data, current.nextPage, {
            runId: current.runId,
            startDate: current.startDate,
            endDate: current.endDate,
            statusId: current.statusId
          });
        }
      } catch (error) {
        PRALogger.error('initial_orders_load_page_persist_failed', {
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
        var completed = publicSummary_('completed', 'initial_load_completed', current, startedAt);
        clearCheckpointAndSaveRun_(completed);
        PRALogger.info('initial_orders_load_completed', {
          runId: current.runId,
          pagesFetched: current.pagesFetched,
          recordsFetched: current.recordsFetched,
          startDate: current.startDate,
          endDate: current.endDate
        });
        return completed;
      }

      saveCheckpoint_(current);
    }

    var inProgress = publicSummary_('in_progress', 'checkpoint_saved', current, startedAt);
    PRALogger.info('initial_orders_load_checkpoint_saved', {
      runId: current.runId,
      pagesFetched: current.pagesFetched,
      recordsFetched: current.recordsFetched,
      nextPage: current.nextPage
    });
    return inProgress;
  }

  return Object.freeze({
    run: run,
    validate: validate_
  });
})();
