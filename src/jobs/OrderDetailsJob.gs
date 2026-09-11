var PRAOrderDetailsJob = (function () {
  'use strict';

  function positiveLimit_(value, fallback) {
    if (value === null || typeof value === 'undefined' || value === '') return fallback;
    var candidate = Number(value);
    return Number.isInteger(candidate) && candidate >= 1 && candidate <= 100 ? candidate : null;
  }

  function failure_(code, message, metadata) {
    return Object.assign({ ok: false, status: 'blocked', code: code, message: message }, metadata || {});
  }

  function validDetail_(detail, expectedId) {
    return detail && typeof detail === 'object' &&
      String(detail.id || '') === String(expectedId) &&
      Array.isArray(detail.itens);
  }

  function shouldRetry_(response, invalidResponse) {
    if (invalidResponse || !response || !response.error) return false;
    if (response.error.retryable) return true;
    return ['unauthorized', 'forbidden'].indexOf(response.error.code) >= 0;
  }

  function run(options) {
    options = options || {};
    var policy = PRAConfig.getRequestPolicy();
    var maxOrders = positiveLimit_(options.maxOrders, policy.maxOrderDetailsPerRun);
    if (!maxOrders) {
      return failure_('detail_batch_size_invalid', 'O lote deve conter entre 1 e 100 pedidos.', {});
    }
    if (!PRAConfig.getPublicValue(PRAConfig.KEYS.DATA_SPREADSHEET_ID, null)) {
      return failure_(
        'data_spreadsheet_missing',
        'Configure DATA_SPREADSHEET_ID antes de coletar detalhes.',
        {}
      );
    }

    var queueEntries = PRAOrderDetailsQueue.peek(maxOrders);
    var queueBefore = PRAOrderDetailsQueue.getSummary();
    var startedAt = new Date().toISOString();
    var runId = Utilities.getUuid();
    if (queueEntries.length === 0) {
      return {
        ok: true,
        status: 'completed',
        code: 'order_details_queue_empty',
        runId: runId,
        batchSize: 0,
        ordersStored: 0,
        itemsStored: 0,
        errorsStored: 0,
        retryableFailures: 0,
        permanentFailures: 0,
        pending: 0,
        startedAt: startedAt,
        updatedAt: new Date().toISOString()
      };
    }

    var details = [];
    var failures = [];
    var outcomes = [];
    queueEntries.forEach(function (entry) {
      var response = PRABlingClient.get(
        '/pedidos/vendas/' + entry.id,
        {},
        { operation: 'sales-orders.detail' }
      );
      if (response.ok && validDetail_(response.data, entry.id)) {
        details.push(response.data);
        outcomes.push({ id: entry.id, status: 'success' });
        return;
      }
      var invalidResponse = response.ok;
      var retryable = shouldRetry_(response, invalidResponse);
      failures.push({
        orderId: entry.id,
        errorCode: invalidResponse ? 'invalid_response' :
          (response.error && response.error.code || 'unknown_error'),
        statusCode: response.statusCode,
        correlationId: response.correlationId,
        attempts: Number(entry.attempts || 0) + 1,
        retryable: Boolean(retryable)
      });
      outcomes.push({
        id: entry.id,
        status: retryable ? 'retryable_failure' : 'permanent_failure'
      });
    });

    var stored;
    try {
      stored = PRAOrderDetailsStore.persistBatch(details, failures, { runId: runId });
    } catch (error) {
      PRALogger.error('order_details_storage_failed', {
        runId: runId,
        batchSize: queueEntries.length,
        pending: queueBefore.pending
      });
      return failure_(
        'order_details_storage_failed',
        'O lote foi consultado, mas não foi confirmado no armazenamento.',
        {
          runId: runId,
          batchSize: queueEntries.length,
          pending: queueBefore.pending,
          startedAt: startedAt,
          updatedAt: new Date().toISOString()
        }
      );
    }

    var queueAfter = PRAOrderDetailsQueue.acknowledge(outcomes);
    var retryableFailures = failures.filter(function (failure) { return failure.retryable; }).length;
    var permanentFailures = failures.length - retryableFailures;
    var status = queueAfter.pending > 0 ? 'in_progress' :
      (permanentFailures > 0 ? 'completed_with_errors' : 'completed');
    var result = {
      ok: true,
      status: status,
      code: status === 'in_progress' ? 'order_details_checkpoint_saved' :
        (status === 'completed_with_errors' ? 'order_details_completed_with_errors' :
          'order_details_completed'),
      runId: runId,
      batchSize: queueEntries.length,
      ordersStored: stored.ordersStored,
      itemsStored: stored.itemsStored,
      errorsStored: stored.errorsStored,
      retryableFailures: retryableFailures,
      permanentFailures: permanentFailures,
      pending: queueAfter.pending,
      startedAt: startedAt,
      updatedAt: stored.updatedAt
    };
    PRALogger.info('order_details_batch_finished', {
      runId: runId,
      status: status,
      batchSize: result.batchSize,
      ordersStored: result.ordersStored,
      itemsStored: result.itemsStored,
      errorsStored: result.errorsStored,
      pending: result.pending
    });
    return result;
  }

  return Object.freeze({ run: run });
})();
