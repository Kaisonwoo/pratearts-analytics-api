var PRADailySyncJob = (function () {
  'use strict';

  function run(options) {
    options = options || {};
    var incrementalOptions = {
      reset: Boolean(options.reset),
      today: options.today,
      lookbackDays: options.lookbackDays,
      pageSize: options.pageSize,
      maxPagesPerRun: options.maxPagesPerRun,
      onPage: typeof options.onPage === 'function' ? options.onPage : function (orders, page, context) {
        return PRAOrderDetailsQueue.enqueuePage(orders, page, context);
      }
    };

    var result = PRAOrdersIncrementalSync.run(incrementalOptions);
    PRALogger.info('daily_sync_incremental_result', {
      ok: Boolean(result && result.ok),
      status: result && result.status,
      code: result && result.code
    });
    return result;
  }

  return Object.freeze({ run: run });
})();
