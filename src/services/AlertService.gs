var PRAAlertService = (function () {
  'use strict';

  function safeCode_(value) {
    var code = String(value || 'unknown_error');
    return /^[a-z0-9_]{1,80}$/i.test(code) ? code : 'unknown_error';
  }

  function safeCorrelationId_(value) {
    var correlationId = String(value || '');
    return /^[a-z0-9-]{1,80}$/i.test(correlationId) ? correlationId : '';
  }

  function notifyCritical(entry) {
    entry = entry || {};
    var webhook = PRASecrets.getGoogleChatAlertWebhook();
    var code = safeCode_(entry.code);
    var correlationId = safeCorrelationId_(entry.correlationId);
    if (!webhook) {
      PRALogger.warn('critical_alert_not_configured', {
        code: code,
        correlationId: correlationId
      });
      return { configured: false, delivered: false, code: 'alert_not_configured' };
    }
    if (String(webhook).indexOf('https://chat.googleapis.com/') !== 0) {
      PRALogger.error('critical_alert_invalid_configuration', {
        code: code,
        correlationId: correlationId
      });
      return { configured: true, delivered: false, code: 'alert_invalid_configuration' };
    }

    var text = [
      'Pratearts Analytics API — falha crítica',
      'job: ' + String(entry.jobName || 'daily_sync'),
      'code: ' + code,
      'correlationId: ' + correlationId,
      'timestamp: ' + String(entry.timestamp || new Date().toISOString())
    ].join('\n');
    var response;
    try {
      response = UrlFetchApp.fetch(webhook, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: text }),
        muteHttpExceptions: true
      });
    } catch (error) {
      PRALogger.error('critical_alert_delivery_failed', {
        code: code,
        correlationId: correlationId
      });
      return { configured: true, delivered: false, code: 'alert_delivery_failed' };
    }
    var statusCode = Number(response.getResponseCode());
    var delivered = statusCode >= 200 && statusCode < 300;
    PRALogger[delivered ? 'info' : 'error'](
      delivered ? 'critical_alert_delivered' : 'critical_alert_rejected',
      { code: code, correlationId: correlationId, statusCode: statusCode }
    );
    return {
      configured: true,
      delivered: delivered,
      code: delivered ? 'alert_delivered' : 'alert_rejected',
      statusCode: statusCode
    };
  }

  return Object.freeze({ notifyCritical: notifyCritical });
})();
