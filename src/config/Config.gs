var PRAConfig = (function () {
  'use strict';

  var KEYS = Object.freeze({
    BLING_CLIENT_ID: 'BLING_CLIENT_ID',
    BLING_CLIENT_SECRET: 'BLING_CLIENT_SECRET',
    BLING_ACCESS_TOKEN: 'BLING_ACCESS_TOKEN',
    BLING_REFRESH_TOKEN: 'BLING_REFRESH_TOKEN',
    BLING_TOKEN_EXPIRES_AT: 'BLING_TOKEN_EXPIRES_AT',
    BLING_STATUS_ATENDIDO_ID: 'BLING_STATUS_ATENDIDO_ID',
    DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID',
    SYNC_TIMEZONE: 'SYNC_TIMEZONE',
    SYNC_HOUR: 'SYNC_HOUR'
  });

  var DEFAULTS = Object.freeze({
    API_BASE_URL: 'https://api.bling.com.br/Api/v3',
    SYNC_TIMEZONE: 'America/Sao_Paulo',
    SYNC_HOUR: '6'
  });

  var SENSITIVE_KEYS = Object.freeze([
    KEYS.BLING_CLIENT_ID,
    KEYS.BLING_CLIENT_SECRET,
    KEYS.BLING_ACCESS_TOKEN,
    KEYS.BLING_REFRESH_TOKEN
  ]);

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function get(key, fallbackValue) {
    var value = properties_().getProperty(key);
    return value === null || value === '' ? fallbackValue : value;
  }

  function requireValue(key) {
    var value = get(key, null);
    if (!value) {
      throw new Error('Configuração obrigatória ausente: ' + key);
    }
    return value;
  }

  function getPublicSnapshot() {
    var props = properties_();
    var present = {};
    Object.keys(KEYS).forEach(function (name) {
      var key = KEYS[name];
      present[key] = Boolean(props.getProperty(key));
    });

    return {
      apiBaseUrl: DEFAULTS.API_BASE_URL,
      syncTimezone: get(KEYS.SYNC_TIMEZONE, DEFAULTS.SYNC_TIMEZONE),
      syncHour: Number(get(KEYS.SYNC_HOUR, DEFAULTS.SYNC_HOUR)),
      configuredProperties: present
    };
  }

  function isSensitiveKey(key) {
    return SENSITIVE_KEYS.indexOf(key) >= 0;
  }

  return Object.freeze({
    KEYS: KEYS,
    DEFAULTS: DEFAULTS,
    get: get,
    requireValue: requireValue,
    getPublicSnapshot: getPublicSnapshot,
    isSensitiveKey: isSensitiveKey
  });
})();
