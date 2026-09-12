var PRAExecutionLease = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var PREFIX = 'PRA_EXECUTION_LEASE_';
  var DEFAULT_TTL_MS = 390000;

  function key_(name) {
    var normalized = String(name || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!normalized) throw new Error('Nome do lease de execucao obrigatorio.');
    return PREFIX + normalized;
  }

  function parse_(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  }

  function acquire(name, ttlMs) {
    var leaseKey = key_(name);
    var ttl = Number(ttlMs || DEFAULT_TTL_MS);
    if (!Number.isInteger(ttl) || ttl < 60000 || ttl > 600000) {
      throw new Error('Validade do lease deve estar entre 1 e 10 minutos.');
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var properties = PropertiesService.getScriptProperties();
      var now = Date.now();
      var current = parse_(properties.getProperty(leaseKey));
      if (current && current.token && Number(current.expiresAt) > now) {
        return { acquired: false, name: String(name), expiresAt: Number(current.expiresAt) };
      }
      var lease = {
        acquired: true,
        name: String(name),
        key: leaseKey,
        token: Utilities.getUuid(),
        expiresAt: now + ttl
      };
      var values = {};
      values[leaseKey] = JSON.stringify({ token: lease.token, expiresAt: lease.expiresAt });
      properties.setProperties(values, false);
      return lease;
    } finally {
      lock.releaseLock();
    }
  }

  function release(lease) {
    if (!lease || !lease.acquired || !lease.key || !lease.token) return false;
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var properties = PropertiesService.getScriptProperties();
      var current = parse_(properties.getProperty(lease.key));
      if (!current || current.token !== lease.token) return false;
      properties.deleteProperty(lease.key);
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  return Object.freeze({ acquire: acquire, release: release });
})();
