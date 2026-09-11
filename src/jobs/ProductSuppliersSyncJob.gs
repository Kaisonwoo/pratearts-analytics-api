var PRAProductSuppliersSyncJob = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var ALLOWED_PRIMARY_RULES = Object.freeze([
    'marked_default',
    'lowest_purchase_price',
    'lowest_cost_price',
    'lowest_supplier_id'
  ]);

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
        'Configure DATA_SPREADSHEET_ID antes de coletar vínculos de fornecedores.',
        {}
      );
    }

    var policy = PRAConfig.getRequestPolicy();
    var pageSize = Number(options.pageSize || policy.pageSize);
    var maxPagesPerRun = Number(options.maxPagesPerRun || policy.maxPagesPerRun);
    var primaryRule = String(
      options.primaryRule ||
      PRAConfig.getPublicValue(
        PRAConfig.KEYS.BLING_PRIMARY_SUPPLIER_RULE,
        PRAConfig.DEFAULTS.BLING_PRIMARY_SUPPLIER_RULE
      )
    );

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
    if (ALLOWED_PRIMARY_RULES.indexOf(primaryRule) < 0) {
      return failure_(
        'primary_supplier_rule_invalid',
        'A regra de fornecedor principal configurada não é suportada.',
        {}
      );
    }

    return {
      ok: true,
      pageSize: pageSize,
      maxPages: policy.maxPages,
      maxPagesPerRun: maxPagesPerRun,
      primaryRule: primaryRule,
      fingerprint: String(pageSize) + ':' + primaryRule
    };
  }

  function newCheckpoint_(settings) {
    var now = new Date().toISOString();
    return {
      runId: Utilities.getUuid(),
      fingerprint: settings.fingerprint,
      pageSize: settings.pageSize,
      primaryRule: settings.primaryRule,
      phase: 'fetch',
      nextPage: 1,
      pagesFetched: 0,
      linksFetched: 0,
      startedAt: now,
      updatedAt: now
    };
  }

  function saveCheckpoint_(checkpoint) {
    withLock_(function (props) {
      var values = {};
      values[PRAConfig.KEYS.BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT] = JSON.stringify(checkpoint);
      props.setProperties(values, false);
    });
  }

  function clearCheckpointAndSaveRun_(summary) {
    withLock_(function (props) {
      props.deleteProperty(PRAConfig.KEYS.BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT);
      var values = {};
      values[PRAConfig.KEYS.BLING_LAST_PRODUCT_SUPPLIERS_SYNC_RUN] = JSON.stringify(summary);
      props.setProperties(values, false);
    });
  }

  function publicSummary_(status, code, checkpoint, reconciliation) {
    var summary = {
      ok: true,
      status: status,
      code: code,
      runId: checkpoint.runId,
      phase: checkpoint.phase,
      pagesFetched: checkpoint.pagesFetched,
      linksFetched: checkpoint.linksFetched,
      nextPage: checkpoint.nextPage,
      primaryRule: checkpoint.primaryRule,
      startedAt: checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt
    };
    if (reconciliation) {
      summary.linksStored = Number(reconciliation.linksStored || 0);
      summary.productsEvaluated = Number(reconciliation.productsEvaluated || 0);
      summary.productsWithoutSupplier = Number(reconciliation.productsWithoutSupplier || 0);
      summary.productsWithSingleSupplier = Number(reconciliation.productsWithSingleSupplier || 0);
      summary.productsWithMultipleSuppliers = Number(reconciliation.productsWithMultipleSuppliers || 0);
      summary.updatedAt = reconciliation.updatedAt || summary.updatedAt;
    }
    return summary;
  }

  function reconcile_(checkpoint) {
    var reconciliation;
    try {
      reconciliation = PRAProductSupplierStore.finalizeRun(
        checkpoint.runId,
        checkpoint.primaryRule
      );
    } catch (error) {
      PRALogger.error('product_suppliers_reconciliation_failed', {
        runId: checkpoint.runId,
        pagesFetched: checkpoint.pagesFetched,
        linksFetched: checkpoint.linksFetched
      });
      return failure_(
        'supplier_reconciliation_failed',
        'Os vínculos foram coletados, mas a reconciliação final não foi confirmada.',
        publicSummary_('blocked', 'supplier_reconciliation_failed', checkpoint)
      );
    }

    checkpoint.updatedAt = reconciliation.updatedAt || new Date().toISOString();
    var completed = publicSummary_(
      'completed',
      'product_suppliers_sync_completed',
      checkpoint,
      reconciliation
    );
    clearCheckpointAndSaveRun_(completed);
    PRALogger.info('product_suppliers_sync_completed', {
      runId: checkpoint.runId,
      pagesFetched: checkpoint.pagesFetched,
      linksFetched: checkpoint.linksFetched,
      productsEvaluated: completed.productsEvaluated,
      productsWithoutSupplier: completed.productsWithoutSupplier,
      productsWithMultipleSuppliers: completed.productsWithMultipleSuppliers,
      primaryRule: checkpoint.primaryRule
    });
    return completed;
  }

  function run(options) {
    options = options || {};
    var settings = validate_(options);
    if (!settings.ok) {
      PRALogger.warn('product_suppliers_sync_blocked', { code: settings.code });
      return settings;
    }

    var current = readJson_(PRAConfig.KEYS.BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT);
    if (options.reset) {
      current = null;
      withLock_(function (props) {
        props.deleteProperty(PRAConfig.KEYS.BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT);
      });
    }
    if (!current || current.fingerprint !== settings.fingerprint) {
      current = newCheckpoint_(settings);
      saveCheckpoint_(current);
    }

    if (current.phase === 'reconcile') {
      return reconcile_(current);
    }

    var pagesThisRun = 0;
    while (pagesThisRun < settings.maxPagesPerRun) {
      if (current.pagesFetched >= settings.maxPages) {
        return failure_(
          'page_limit_reached',
          'A coleta de vínculos atingiu o limite seguro de páginas.',
          publicSummary_('blocked', 'page_limit_reached', current)
        );
      }

      var pageResult = PRABlingClient.get('/produtos/fornecedores', {
        pagina: current.nextPage,
        limite: current.pageSize
      }, { operation: 'product-suppliers.full-reconciliation' });

      if (!pageResult.ok) {
        PRALogger.warn('product_suppliers_sync_page_failed', {
          runId: current.runId,
          page: current.nextPage,
          statusCode: pageResult.statusCode,
          errorCode: pageResult.error && pageResult.error.code
        });
        return failure_(
          'page_fetch_failed',
          'A página de vínculos não foi carregada; o checkpoint anterior foi preservado.',
          {
            runId: current.runId,
            page: current.nextPage,
            statusCode: pageResult.statusCode,
            errorCode: pageResult.error && pageResult.error.code,
            pagesFetched: current.pagesFetched,
            linksFetched: current.linksFetched,
            nextPage: current.nextPage,
            primaryRule: current.primaryRule
          }
        );
      }
      if (!Array.isArray(pageResult.data)) {
        return failure_(
          'response_invalid',
          'A resposta da página não contém uma lista de vínculos produto-fornecedor.',
          { runId: current.runId, page: current.nextPage, nextPage: current.nextPage }
        );
      }

      var stored;
      try {
        stored = PRAProductSupplierStore.persistPage(pageResult.data, {
          runId: current.runId,
          page: current.nextPage
        });
      } catch (error) {
        PRALogger.error('product_suppliers_sync_page_persist_failed', {
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
            linksFetched: current.linksFetched,
            nextPage: current.nextPage,
            primaryRule: current.primaryRule
          }
        );
      }

      current.pagesFetched += 1;
      current.linksFetched += pageResult.data.length;
      current.nextPage += 1;
      current.updatedAt = stored.updatedAt || new Date().toISOString();
      pagesThisRun += 1;

      if (pageResult.data.length < current.pageSize) {
        current.phase = 'reconcile';
        saveCheckpoint_(current);
        return reconcile_(current);
      }

      saveCheckpoint_(current);
    }

    var inProgress = publicSummary_(
      'in_progress',
      'product_suppliers_sync_checkpoint_saved',
      current
    );
    PRALogger.info('product_suppliers_sync_checkpoint_saved', {
      runId: current.runId,
      pagesFetched: current.pagesFetched,
      linksFetched: current.linksFetched,
      nextPage: current.nextPage,
      primaryRule: current.primaryRule
    });
    return inProgress;
  }

  return Object.freeze({
    run: run,
    validate: validate_
  });
})();
