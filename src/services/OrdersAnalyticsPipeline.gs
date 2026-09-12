var PRAOrdersAnalyticsPipeline = (function () {
  'use strict';

  function safeResult_(normalization, validity) {
    var normalizationOk = Boolean(normalization && normalization.ok);
    var normalizationCompleted = Boolean(
      normalizationOk && normalization.status === 'completed'
    );
    var validityCompleted = Boolean(validity && validity.ok && validity.status === 'completed');
    var waiting = normalizationOk && !normalizationCompleted;
    var ok = waiting || (normalizationCompleted && validityCompleted);
    var status = normalizationCompleted && validityCompleted
      ? 'completed'
      : String((validity && validity.status) || (normalization && normalization.status) || 'blocked');

    return {
      ok: ok,
      status: status,
      code: normalizationCompleted && validityCompleted
        ? 'orders_analytics_completed'
        : String((validity && validity.code) || (normalization && normalization.code) || 'orders_analytics_blocked'),
      runId: normalization && normalization.runId,
      ordersRead: Number(normalization && normalization.ordersRead || 0),
      ordersStaged: Number(normalization && normalization.ordersStaged || 0),
      itemsRead: Number(normalization && normalization.itemsRead || 0),
      itemsStaged: Number(normalization && normalization.itemsStaged || 0),
      itemRevenueCalculated: Number(normalization && normalization.itemRevenueCalculated || 0),
      itemRevenueErrors: Number(normalization && normalization.itemRevenueErrors || 0),
      qualityErrors: Number(normalization && normalization.qualityErrors || 0),
      validOrders: Number(validity && validity.validOrders || 0),
      excludedOrders: Number(validity && validity.excludedOrders || 0),
      processedAt: normalization && normalization.processedAt
    };
  }

  function run(options) {
    var normalization = PRATransformService.run(options || {});
    if (!normalization || !normalization.ok || normalization.status !== 'completed') {
      return safeResult_(normalization, null);
    }
    if (Number(normalization.itemRevenueErrors || 0) > 0) {
      var blocked = safeResult_(normalization, null);
      blocked.ok = false;
      blocked.status = 'blocked';
      blocked.code = 'item_revenue_quality_blocked';
      return blocked;
    }

    var validity = PRAValidSalesService.run();
    return safeResult_(normalization, validity);
  }

  return Object.freeze({ run: run });
})();
