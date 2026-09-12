var PRADailySyncJob = (function () {
  'use strict';

  var CONTINUATION_HANDLER = 'runDailySyncContinuation';

  function schedule_(shouldContinue, options) {
    if (options.scheduleContinuation === false ||
        typeof PRAContinuationScheduler === 'undefined') {
      return { ok: true, scheduled: false };
    }
    try {
      return shouldContinue
        ? PRAContinuationScheduler.schedule(CONTINUATION_HANDLER, 60000)
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

  function run(options) {
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
      normalization = PRATransformService.run({
        maxRuntimeMs: executionBudgetMs,
        deadlineAtMs: budget.deadlineAtMs,
        reserveMs: budget.reserveMs
      });
    }

    var qualityBlocked = Boolean(details && queue.pending === 0 && unresolvedErrors > 0);
    var blocked = !incremental || !incremental.ok ||
      (reconciliation && !reconciliation.ok) ||
      (details && !details.ok) ||
      (normalization && !normalization.ok) || qualityBlocked;
    var inProgress = !blocked && (
      incremental.status === 'in_progress' ||
      (reconciliation && reconciliation.status === 'in_progress') ||
      queue.pending > 0 ||
      !normalization || normalization.status === 'in_progress'
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

  return Object.freeze({ run: run });
})();
