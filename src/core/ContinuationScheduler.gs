var PRAContinuationScheduler = (function () {
  'use strict';

  var ALLOWED_HANDLERS = Object.freeze(['runDailySyncContinuation']);
  var DEFAULT_DELAY_MS = 60000;
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

  function validateHandler_(handler) {
    var name = String(handler || '');
    if (ALLOWED_HANDLERS.indexOf(name) < 0) {
      throw new Error('Handler de continuacao nao permitido.');
    }
    return name;
  }

  function matching_(handler) {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === handler;
    });
  }

  function schedule(handler, delayMs) {
    var name = validateHandler_(handler);
    var delay = Number(delayMs || DEFAULT_DELAY_MS);
    if (!Number.isInteger(delay) || delay < 60000 || delay > 3600000) {
      throw new Error('A continuacao deve ser agendada entre 1 e 60 minutos.');
    }
    return withLock_(function () {
      var existing = matching_(name);
      if (existing.length > 0) {
        return { ok: true, scheduled: false, existing: true, handler: name };
      }
      ScriptApp.newTrigger(name).timeBased().after(delay).create();
      return { ok: true, scheduled: true, existing: false, handler: name };
    });
  }

  function cancel(handler) {
    var name = validateHandler_(handler);
    return withLock_(function () {
      var triggers = matching_(name);
      triggers.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
      return { ok: true, deleted: triggers.length, handler: name };
    });
  }

  return Object.freeze({ schedule: schedule, cancel: cancel });
})();
