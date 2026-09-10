var PRAResilience = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;

  function policy_() {
    var policy = PRAConfig.getRequestPolicy();
    if (!PRAConfig.validate().valid) {
      throw new Error('Configuração de resiliência do Bling inválida.');
    }
    return policy;
  }

  function sleep_(milliseconds) {
    if (milliseconds > 0) {
      Utilities.sleep(milliseconds);
    }
  }

  function acquireRateLimitSlot() {
    var policy = policy_();
    var intervalMs = Math.ceil(1000 / policy.requestsPerSecond);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);

    try {
      var properties = PropertiesService.getScriptProperties();
      var now = Date.now();
      var stored = Number(properties.getProperty(PRAConfig.KEYS.BLING_NEXT_REQUEST_AT));
      var nextRequestAt = Number.isFinite(stored) && stored > 0 ? stored : now;

      if (nextRequestAt - now > intervalMs) {
        nextRequestAt = now;
      }

      var waitMs = Math.max(0, nextRequestAt - now);
      sleep_(waitMs);
      var grantedAt = Date.now();
      properties.setProperty(
        PRAConfig.KEYS.BLING_NEXT_REQUEST_AT,
        String(grantedAt + intervalMs)
      );
      return waitMs;
    } finally {
      lock.releaseLock();
    }
  }

  function isRetryableStatus(statusCode, networkFailure) {
    return Boolean(networkFailure) ||
      statusCode === 408 ||
      statusCode === 429 ||
      statusCode >= 500;
  }

  function getBackoffDelay(attemptNumber) {
    var policy = policy_();
    var exponent = Math.max(0, Number(attemptNumber) - 1);
    return Math.min(
      policy.backoffMaxMs,
      policy.backoffBaseMs * Math.pow(2, exponent)
    );
  }

  function waitBeforeRetry(attemptNumber) {
    var delayMs = getBackoffDelay(attemptNumber);
    sleep_(delayMs);
    return delayMs;
  }

  return Object.freeze({
    acquireRateLimitSlot: acquireRateLimitSlot,
    isRetryableStatus: isRetryableStatus,
    getBackoffDelay: getBackoffDelay,
    waitBeforeRetry: waitBeforeRetry
  });
})();
