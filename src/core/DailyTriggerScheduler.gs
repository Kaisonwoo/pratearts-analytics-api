var PRADailyTriggerScheduler = (function () {
  'use strict';

  var HANDLER = 'runDailySync';
  var SIGNATURE_KEY = 'PRA_DAILY_TRIGGER_SIGNATURE';
  var LOCK_TIMEOUT_MS = 30000;

  function withLock_(callback) {
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      return callback();
    } finally {
      lock.releaseLock();
    }
  }

  function configuration_() {
    var snapshot = PRAConfig.getPublicSnapshot();
    var hour = Number(snapshot.syncHour);
    var timezone = String(snapshot.syncTimezone || '');
    if (!snapshot.validation || !snapshot.validation.valid ||
        !Number.isInteger(hour) || hour < 0 || hour > 23 || !timezone) {
      throw new Error('Configuracao da agenda diaria invalida.');
    }
    return {
      handler: HANDLER,
      hour: hour,
      timezone: timezone,
      signature: [HANDLER, timezone, hour].join('|')
    };
  }

  function matching_() {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === HANDLER;
    });
  }

  function publicStatus_(config, triggers, storedSignature) {
    return {
      ok: true,
      handler: HANDLER,
      installed: triggers.length,
      configured: triggers.length === 1 && storedSignature === config.signature,
      hour: config.hour,
      timezone: config.timezone
    };
  }

  function status() {
    var config = configuration_();
    var properties = PropertiesService.getScriptProperties();
    return publicStatus_(config, matching_(), properties.getProperty(SIGNATURE_KEY));
  }

  function install() {
    return withLock_(function () {
      var config = configuration_();
      var properties = PropertiesService.getScriptProperties();
      var existing = matching_();
      var storedSignature = properties.getProperty(SIGNATURE_KEY);
      if (existing.length === 1 && storedSignature === config.signature) {
        var current = publicStatus_(config, existing, storedSignature);
        current.created = false;
        current.replaced = 0;
        return current;
      }

      var created;
      try {
        created = ScriptApp.newTrigger(HANDLER)
          .timeBased()
          .atHour(config.hour)
          .nearMinute(0)
          .everyDays(1)
          .inTimezone(config.timezone)
          .create();
      } catch (error) {
        PRALogger.error('daily_trigger_install_failed', {
          handler: HANDLER,
          existing: existing.length
        });
        throw new Error('Nao foi possivel instalar o acionador diario.');
      }

      existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
      properties.setProperty(SIGNATURE_KEY, config.signature);
      PRALogger.info('daily_trigger_installed', {
        handler: HANDLER,
        hour: config.hour,
        timezone: config.timezone,
        replaced: existing.length
      });
      var result = publicStatus_(config, created ? [created] : matching_(), config.signature);
      result.created = true;
      result.replaced = existing.length;
      return result;
    });
  }

  function remove() {
    return withLock_(function () {
      var config = configuration_();
      var properties = PropertiesService.getScriptProperties();
      var existing = matching_();
      existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
      properties.deleteProperty(SIGNATURE_KEY);
      PRALogger.info('daily_trigger_removed', {
        handler: HANDLER,
        deleted: existing.length
      });
      var result = publicStatus_(config, [], null);
      result.deleted = existing.length;
      return result;
    });
  }

  return Object.freeze({ install: install, remove: remove, status: status });
})();
