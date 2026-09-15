var PRADailySyncJob = (function () {
  'use strict';

  var CONTINUATION_HANDLER = 'runDailySyncContinuation';

  function number_(value) {
    value = Number(value || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function executionMetrics_(result) {
    result = result || {};
    var incremental = result.incremental || {};
    var reconciliation = result.reconciliation || {};
    var details = result.details || {};
    var pages = number_(incremental.pagesFetched) + number_(reconciliation.pagesFetched);
    var records = number_(details.ordersStored) + number_(details.itemsStored);
    if (!records) {
      records = number_(incremental.recordsFetched) + number_(reconciliation.recordsFetched);
    }
    return { pagesProcessed: pages, recordsProcessed: records };
  }

  function firstCorrelationId_(value) {
    if (!value || typeof value !== 'object') return '';
    if (value.correlationId) return String(value.correlationId);
    var keys = Object.keys(value);
    for (var index = 0; index < keys.length; index += 1) {
      var nested = firstCorrelationId_(value[keys[index]]);
      if (nested) return nested;
    }
    return '';
  }

  function recordStart_(entry) {
    try {
      PRASyncRunStore.start(entry);
    } catch (error) {
      PRALogger.error('sync_run_start_persistence_failed', {
        runId: entry.runId,
        correlationId: entry.correlationId
      });
    }
  }

  function recordFinish_(entry) {
    try {
      PRASyncRunStore.finish(entry);
    } catch (error) {
      PRALogger.error('sync_run_finish_persistence_failed', {
        runId: entry.runId,
        correlationId: entry.correlationId
      });
    }
  }

  function alertBlocked_(entry) {
    try {
      return PRAAlertService.notifyCritical(entry);
    } catch (error) {
      PRALogger.error('critical_alert_unexpected_failure', {
        code: entry.code,
        correlationId: entry.correlationId
      });
      return { configured: null, delivered: false, code: 'alert_internal_failure' };
    }
  }

  function schedule_(shouldContinue, options) {
    if (options.scheduleContinuation === false ||
        typeof PRAContinuationScheduler === 'undefined') {
      return { ok: true, scheduled: false };
    }
    try {
      return shouldContinue
        ? PRAContinuationScheduler.schedule(CONTINUATION_HANDLER, 60000, {
          replaceExisting: Boolean(options.replaceContinuation)
        })
        : PRAContinuationScheduler.cancel(CONTINUATION_HANDLER);
    } catch (error) {
      PRALogger.error('daily_sync_continuation_failed', {});
      return { ok: false, scheduled: false };
    }
  }

  function retryableBlocked_(result) {
    if (!result || result.ok || result.status !== 'blocked') return false;
    return [
      'page_fetch_failed',
      'page_persistence_failed',
      'recalc_stage_failed',
      'order_details_storage_failed',
      'recalculation_activation_failed'
    ].indexOf(String(result.code || '')) >= 0;
  }

  function runWithLease_(options) {
    options = options || {};
    var policy = PRAConfig.getRequestPolicy();
    var executionBudgetMs = Number(options.maxRuntimeMs || policy.executionBudgetMs || 270000);
    var budget = PRARuntimeBudget.create({
      budgetMs: executionBudgetMs,
      deadlineAtMs: options.deadlineAtMs,
      reserveMs: typeof options.reserveMs === 'undefined' ? 15000 : options.reserveMs
    });
    var incrementalOptions = {
      reset: Boolean(options.reset),
      today: options.today,
      lookbackDays: options.lookbackDays,
      pageSize: options.pageSize,
      maxPagesPerRun: options.maxPagesPerRun,
      maxRuntimeMs: executionBudgetMs,
      deadlineAtMs: budget.deadlineAtMs,
      reserveMs: budget.reserveMs,
      onPage: typeof options.onPage === 'function' ? options.onPage : function (orders, page, context) {
        return PRAOrderDetailsQueue.enqueuePage(orders, page, context);
      }
    };

    var incremental = PRAOrdersIncrementalSync.run(incrementalOptions);
    PRALogger.info('daily_sync_incremental_result', {
      ok: Boolean(incremental && incremental.ok),
      status: incremental && incremental.status,
      code: incremental && incremental.code
    });

    var reconciliation = null;
    if (incremental && incremental.ok && !budget.shouldYield() &&
        typeof PRAOrdersReconciliationJob !== 'undefined') {
      reconciliation = PRAOrdersReconciliationJob.run({
        today: options.today,
        maxRuntimeMs: executionBudgetMs,
        deadlineAtMs: budget.deadlineAtMs,
        reserveMs: budget.reserveMs,
        onPage: function (orders, page, context) {
          return PRAOrderDetailsQueue.enqueuePage(orders, page, context);
        }
      });
    }

    var details = null;
    if (incremental && incremental.ok && !budget.shouldYield()) {
      details = PRAOrderDetailsJob.run({
        maxOrders: options.maxOrders,
        maxRuntimeMs: executionBudgetMs,
        deadlineAtMs: budget.deadlineAtMs,
        reserveMs: budget.reserveMs
      });
    }

    var queue = PRAOrderDetailsQueue.getSummary();
    var normalization = null;
    var upstreamComplete = incremental && incremental.ok && incremental.status === 'completed' &&
      (!reconciliation || reconciliation.status === 'completed' || reconciliation.status === 'skipped');
    var unresolvedErrors = details && Number(details.unresolvedErrors || 0);
    if (upstreamComplete && queue.pending === 0 && unresolvedErrors === 0 &&
        details && details.ok && !budget.shouldYield()) {
      normalization = PRAOrdersAnalyticsPipeline.run({
        maxRuntimeMs: executionBudgetMs,
        deadlineAtMs: budget.deadlineAtMs,
        reserveMs: budget.reserveMs
      });
    }

    var marts = null;
    if (normalization && normalization.ok && normalization.status === 'completed' && !budget.shouldYield()) {
      marts = PRAMartsJob.run({
        maxRuntimeMs: executionBudgetMs,
        deadlineAtMs: budget.deadlineAtMs,
        reserveMs: Math.min(executionBudgetMs - 1, Math.max(30000, budget.reserveMs)),
        scheduleContinuation: false
      });
    }

    var qualityBlocked = Boolean(details && queue.pending === 0 && unresolvedErrors > 0);
    var blocked = !incremental || !incremental.ok ||
      (reconciliation && !reconciliation.ok) ||
      (details && !details.ok) ||
      (normalization && !normalization.ok) || (marts && !marts.ok) || qualityBlocked;
    var inProgress = !blocked && (
      incremental.status === 'in_progress' ||
      (reconciliation && reconciliation.status === 'in_progress') ||
      queue.pending > 0 ||
      !normalization || normalization.status === 'in_progress' ||
      !marts || marts.status === 'in_progress'
    );
    var retryableBlocked = retryableBlocked_(incremental) ||
      retryableBlocked_(reconciliation) || retryableBlocked_(details);
    var continuation = schedule_(inProgress || retryableBlocked, options);
    if (!continuation.ok) blocked = true;

    var status = blocked ? 'blocked' : (inProgress ? 'in_progress' : 'completed');
    var result = {
      ok: !blocked,
      status: status,
      code: qualityBlocked ? 'daily_sync_unresolved_errors' :
        (blocked ? 'daily_sync_blocked' :
          (inProgress ? 'daily_sync_continuation_scheduled' : 'daily_sync_completed')),
      incremental: incremental,
      reconciliation: reconciliation,
      details: details,
      normalization: normalization,
      marts: marts,
      pending: Number(queue.pending || 0),
      continuationScheduled: Boolean(continuation.scheduled),
      updatedAt: new Date().toISOString()
    };
    PRALogger.info('daily_sync_finished', {
      ok: result.ok,
      status: result.status,
      code: result.code,
      pending: result.pending,
      continuationScheduled: result.continuationScheduled
    });
    return result;
  }

  function run(options) {
    options = options || {};
    var policy = PRAConfig.getRequestPolicy();
    var executionBudgetMs = Number(options.maxRuntimeMs || policy.executionBudgetMs || 270000);
    var leaseTtlMs = Math.min(600000, Math.max(60000, executionBudgetMs + 60000));
    var lease = PRAExecutionLease.acquire('daily_sync', leaseTtlMs);
    if (!lease.acquired) {
      var busy = {
        ok: false,
        status: 'blocked',
        code: 'daily_sync_execution_in_progress',
        retryAfter: new Date(lease.expiresAt).toISOString(),
        pending: null,
        continuationScheduled: false,
        updatedAt: new Date().toISOString()
      };
      PRALogger.info('daily_sync_concurrent_execution_blocked', {
        retryAfter: busy.retryAfter
      });
      return busy;
    }
    var runId = Utilities.getUuid();
    var startedAtMs = Date.now();
    var startedAt = new Date(startedAtMs).toISOString();
    recordStart_({
      runId: runId,
      jobName: 'daily_sync',
      startedAt: startedAt,
      correlationId: runId
    });
    try {
      var result = runWithLease_(options);
      var finishedAt = new Date().toISOString();
      var metrics = executionMetrics_(result);
      var correlationId = firstCorrelationId_(result) || runId;
      result.runId = runId;
      result.correlationId = correlationId;
      result.startedAt = startedAt;
      result.finishedAt = finishedAt;
      result.durationMs = Math.max(0, Date.now() - startedAtMs);
      result.pagesProcessed = metrics.pagesProcessed;
      result.recordsProcessed = metrics.recordsProcessed;
      recordFinish_({
        runId: runId,
        jobName: 'daily_sync',
        status: result.status,
        startedAt: startedAt,
        finishedAt: finishedAt,
        durationMs: result.durationMs,
        pagesProcessed: metrics.pagesProcessed,
        recordsProcessed: metrics.recordsProcessed,
        errorCode: result.ok ? '' : result.code,
        correlationId: correlationId
      });
      if (!result.ok && result.status === 'blocked') {
        result.alert = alertBlocked_({
          jobName: 'daily_sync',
          code: result.code,
          correlationId: correlationId,
          timestamp: finishedAt
        });
      }
      return result;
    } catch (error) {
      var failureFinishedAt = new Date().toISOString();
      var failureCode = String(error && error.code || 'daily_sync_unexpected_failure');
      recordFinish_({
        runId: runId,
        jobName: 'daily_sync',
        status: 'failed',
        startedAt: startedAt,
        finishedAt: failureFinishedAt,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        pagesProcessed: 0,
        recordsProcessed: 0,
        errorCode: failureCode,
        correlationId: runId
      });
      alertBlocked_({
        jobName: 'daily_sync',
        code: failureCode,
        correlationId: runId,
        timestamp: failureFinishedAt
      });
      throw error;
    } finally {
      PRAExecutionLease.release(lease);
    }
  }

  return Object.freeze({ run: run });
})();
