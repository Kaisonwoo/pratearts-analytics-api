var PRALogger = (function () {
  'use strict';

  var REDACTED = '[REDACTED]';
  var SENSITIVE_NAME = /(authorization|token|secret|password|client.?id)/i;

  function sanitize(value, key) {
    if (key && SENSITIVE_NAME.test(key)) {
      return REDACTED;
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return sanitize(item); });
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce(function (output, childKey) {
        output[childKey] = sanitize(value[childKey], childKey);
        return output;
      }, {});
    }
    return value;
  }

  function write(level, eventName, metadata) {
    var entry = {
      level: level,
      event: eventName,
      timestamp: new Date().toISOString(),
      metadata: sanitize(metadata || {})
    };
    console.log(JSON.stringify(entry));
    return entry;
  }

  return Object.freeze({
    info: function (eventName, metadata) { return write('INFO', eventName, metadata); },
    warn: function (eventName, metadata) { return write('WARN', eventName, metadata); },
    error: function (eventName, metadata) { return write('ERROR', eventName, metadata); },
    sanitize: sanitize
  });
})();
