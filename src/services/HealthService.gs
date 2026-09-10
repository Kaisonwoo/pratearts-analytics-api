var PRAHealthService = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var SAFE_CORRELATION_ID = /^[A-Za-z0-9-]{1,80}$/;

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function normalizeTimestamp_(value) {
    var timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  function normalizeCorrelationId_(value) {
    var correlationId = String(value || '');
    return SAFE_CORRELATION_ID.test(correlationId) ? correlationId : null;
  }

  function getLastSuccess_() {
    var props = properties_();
    return {
      checkedAt: normalizeTimestamp_(
        props.getProperty(PRAConfig.KEYS.BLING_LAST_SUCCESS_AT)
      ),
      correlationId: normalizeCorrelationId_(
        props.getProperty(PRAConfig.KEYS.BLING_LAST_SUCCESS_CORRELATION_ID)
      )
    };
  }

  function recordLastSuccess_(checkedAt, correlationId) {
    var safeCheckedAt = normalizeTimestamp_(checkedAt);
    var safeCorrelationId = normalizeCorrelationId_(correlationId);
    if (!safeCheckedAt || !safeCorrelationId) {
      return getLastSuccess_();
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var props = properties_();
      var current = normalizeTimestamp_(
        props.getProperty(PRAConfig.KEYS.BLING_LAST_SUCCESS_AT)
      );
      if (current && Date.parse(current) > Date.parse(safeCheckedAt)) {
        return getLastSuccess_();
      }

      var values = {};
      values[PRAConfig.KEYS.BLING_LAST_SUCCESS_AT] = safeCheckedAt;
      values[PRAConfig.KEYS.BLING_LAST_SUCCESS_CORRELATION_ID] = safeCorrelationId;
      props.setProperties(values, false);
      return {
        checkedAt: safeCheckedAt,
        correlationId: safeCorrelationId
      };
    } finally {
      lock.releaseLock();
    }
  }

  function result_(state, code, statusCode, checkedAt, correlationId, lastSuccess) {
    return {
      state: state,
      code: code,
      statusCode: Number.isInteger(statusCode) ? statusCode : null,
      checkedAt: normalizeTimestamp_(checkedAt),
      correlationId: normalizeCorrelationId_(correlationId),
      lastSuccessfulAt: lastSuccess.checkedAt,
      lastSuccessfulCorrelationId: lastSuccess.correlationId
    };
  }

  function checkBlingConnectivity_(security) {
    var checkedAt = new Date().toISOString();
    var correlationId = Utilities.getUuid();
    var lastSuccess = getLastSuccess_();

    if (!security.configured) {
      return result_(
        'unavailable',
        'configuration_invalid',
        null,
        checkedAt,
        correlationId,
        lastSuccess
      );
    }

    if (!security.authenticated) {
      var expired = Boolean(security.token && security.token.accessTokenPresent);
      return result_(
        expired ? 'expired' : 'unavailable',
        expired ? 'token_expired_or_expiring' : 'authorization_missing',
        null,
        checkedAt,
        correlationId,
        lastSuccess
      );
    }

    var probe = PRABlingClient.probe();
    checkedAt = normalizeTimestamp_(probe.checkedAt) || checkedAt;
    correlationId = normalizeCorrelationId_(probe.correlationId) || correlationId;

    if (probe.ok) {
      lastSuccess = recordLastSuccess_(checkedAt, correlationId);
      return result_(
        'authorized',
        'connected',
        probe.statusCode,
        checkedAt,
        correlationId,
        lastSuccess
      );
    }

    var isExpired = probe.code === 'unauthorized';
    return result_(
      isExpired ? 'expired' : 'unavailable',
      probe.code || 'unavailable',
      probe.statusCode,
      checkedAt,
      correlationId,
      lastSuccess
    );
  }

  function checkBlingConnectivity() {
    return checkBlingConnectivity_(PRABlingClient.getSecurityStatus());
  }

  function getStatus() {
    var configuration = PRAConfig.getPublicSnapshot();
    var blingSecurity = PRABlingClient.getSecurityStatus();
    var connectivity = checkBlingConnectivity_(blingSecurity);
    return {
      application: 'pratearts-analytics-api',
      status: connectivity.state === 'authorized' ? 'ok' : 'degraded',
      runtime: 'Google Apps Script V8',
      checkedAt: connectivity.checkedAt,
      correlationId: connectivity.correlationId,
      blingState: connectivity.state,
      blingConfigured: blingSecurity.configured,
      blingAuthenticated: blingSecurity.authenticated,
      tokenStatus: blingSecurity.token,
      connectivity: connectivity,
      configuration: configuration
    };
  }

  return Object.freeze({
    getStatus: getStatus,
    checkBlingConnectivity: checkBlingConnectivity
  });
})();
