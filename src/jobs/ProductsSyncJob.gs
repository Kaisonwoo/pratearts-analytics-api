var PRAProductsSyncJob = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;

  function properties_() {
    return PropertiesService.getScriptProperties();
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
    return Object.assign({}, metadata || {}, {
      ok: false,
      status: 'blocked',
      code: code,
      message: message
    });
  }

  function validate_(options) {
    options = options || {};
    if (!PRAConfig.getPublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID, null)) {
      return failure_(
        'data_spreadsheet_missing',
        'Configure DATA_SPREADSHEET_ID antes de coletar produtos.',
        {}
      );
    }
    var policy = PRAConfig.getRequestPolicy();
    var pageSize = Number(options.pageSize || policy.pageSize);
    var maxPagesPerRun = Number(options.maxPagesPerRun || policy.maxPagesPerRun);
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
      pageSize: pageSize,
      maxPages: policy.maxPages,
      maxPagesPerRun: maxPagesPerRun,
      fingerprint: String(pageSize)
    };
  }

  function newCheckpoint_(settings) {
    var now = new Date().toISOString();
    return {
      runId: Utilities.getUuid(),
      fingerprint: settings.fingerprint,
      pageSize: settings.pageSize,
      nextPage: 1,
      pagesFetched: 0,
      recordsFetched: 0,
      parentLinksFound: 0,
      startedAt: now,
      updatedAt: now
    };
  }

  function saveCheckpoint_(checkpoint) {
    withLock_(function (props) {
      var values = {};
      values[PRAConfig.KEYS.BLING_PRODUCTS_SYNC_CHECKPOINT] = JSON.stringify(checkpoint);
      props.setProperties(values, false);
    });
  }

  function clearCheckpointAndSaveRun_(summary) {
    withLock_(function (props) {
      props.deleteProperty(PRAConfig.KEYS.BLING_PRODUCTS_SYNC_CHECKPOINT);
      var values = {};
      values[PRAConfig.KEYS.BLING_LAST_PRODUCTS_SYNC_RUN] = JSON.stringify(summary);
      props.setProperties(values, false);
    });
  }

  function publicSummary_(status, code, checkpoint) {
    return {
      ok: true,
      status: status,
      code: code,
      runId: checkpoint.runId,
      pagesFetched: checkpoint.pagesFetched,
      recordsFetched: checkpoint.recordsFetched,
      parentLinksFound: checkpoint.parentLinksFound,
      nextPage: checkpoint.nextPage,
      startedAt: checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt
    };
  }

  function run(options) {
    options = options || {};
    var settings = validate_(options);
    if (!settings.ok) {
      PRALogger.warn('products_sync_blocked', { code: settings.code });
      return settings;
    }

    var current = readJson_(PRAConfig.KEYS.BLING_PRODUCTS_SYNC_CHECKPOINT);
    if (options.reset) {
      current = null;
      withLock_(function (props) {
        props.deleteProperty(PRAConfig.KEYS.BLING_PRODUCTS_SYNC_CHECKPOINT);
      });
    }
    if (!current || current.fingerprint !== settings.fingerprint) {
      current = newCheckpoint_(settings);
      saveCheckpoint_(current);
    }

    var pagesThisRun = 0;
    while (pagesThisRun < settings.maxPagesPerRun) {
      if (current.pagesFetched >= settings.maxPages) {
        return failure_(
          'page_limit_reached',
          'A coleta de produtos atingiu o limite seguro de páginas.',
          publicSummary_('blocked', 'page_limit_reached', current)
        );
      }

      var pageResult = PRABlingClient.get('/produtos', {
        pagina: current.nextPage,
        limite: current.pageSize
      }, { operation: 'products.initial-sync' });

      if (!pageResult.ok) {
        PRALogger.warn('products_sync_page_failed', {
          runId: current.runId,
          page: current.nextPage,
          statusCode: pageResult.statusCode,
          errorCode: pageResult.error && pageResult.error.code,
          correlationId: pageResult.correlationId
        });
        return failure_(
          'page_fetch_failed',
          'A página de produtos não foi carregada; o checkpoint anterior foi preservado.',
          {
            runId: current.runId,
            page: current.nextPage,
            statusCode: pageResult.statusCode,
            errorCode: pageResult.error && pageResult.error.code,
            correlationId: pageResult.correlationId,
            pagesFetched: current.pagesFetched,
            recordsFetched: current.recordsFetched,
            parentLinksFound: current.parentLinksFound,
            nextPage: current.nextPage
          }
        );
      }
      if (!Array.isArray(pageResult.data)) {
        return failure_(
          'response_invalid',
          'A resposta da página não contém uma lista de produtos.',
          { runId: current.runId, page: current.nextPage, nextPage: current.nextPage }
        );
      }

      var stored;
      try {
        stored = PRAProductStore.persistPage(pageResult.data, {
          runId: current.runId,
          page: current.nextPage
        });
      } catch (error) {
        PRALogger.error('products_sync_page_persist_failed', {
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
            parentLinksFound: current.parentLinksFound,
            nextPage: current.nextPage
          }
        );
      }

      current.pagesFetched += 1;
      current.recordsFetched += pageResult.data.length;
      current.parentLinksFound += Number(stored.parentLinksStored || 0);
      current.nextPage += 1;
      current.updatedAt = stored.updatedAt || new Date().toISOString();
      pagesThisRun += 1;

      if (pageResult.data.length < current.pageSize) {
        var completed = publicSummary_('completed', 'products_sync_completed', current);
        clearCheckpointAndSaveRun_(completed);
        PRALogger.info('products_sync_completed', {
          runId: current.runId,
          pagesFetched: current.pagesFetched,
          recordsFetched: current.recordsFetched,
          parentLinksFound: current.parentLinksFound
        });
        return completed;
      }

      saveCheckpoint_(current);
    }

    var inProgress = publicSummary_('in_progress', 'products_sync_checkpoint_saved', current);
    PRALogger.info('products_sync_checkpoint_saved', {
      runId: current.runId,
      pagesFetched: current.pagesFetched,
      recordsFetched: current.recordsFetched,
      parentLinksFound: current.parentLinksFound,
      nextPage: current.nextPage
    });
    return inProgress;
  }

  return Object.freeze({
    run: run,
    validate: validate_
  });
})();
