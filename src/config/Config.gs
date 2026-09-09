var PRAConfig = (function () {
  'use strict';

  var KEYS = Object.freeze({
    BLING_CLIENT_ID: 'BLING_CLIENT_ID',
    BLING_CLIENT_SECRET: 'BLING_CLIENT_SECRET',
    BLING_REDIRECT_URI: 'BLING_REDIRECT_URI',
    BLING_ACCESS_TOKEN: 'BLING_ACCESS_TOKEN',
    BLING_REFRESH_TOKEN: 'BLING_REFRESH_TOKEN',
    BLING_TOKEN_EXPIRES_AT: 'BLING_TOKEN_EXPIRES_AT',
    BLING_OAUTH_STATE_HASH: 'BLING_OAUTH_STATE_HASH',
    BLING_OAUTH_STATE_EXPIRES_AT: 'BLING_OAUTH_STATE_EXPIRES_AT',
    BLING_STATUS_ATENDIDO_ID: 'BLING_STATUS_ATENDIDO_ID',
    DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID',
    SYNC_TIMEZONE: 'SYNC_TIMEZONE',
    SYNC_HOUR: 'SYNC_HOUR'
  });

  var DEFAULTS = Object.freeze({
    API_BASE_URL: 'https://api.bling.com.br/Api/v3',
    AUTHORIZATION_URL: 'https://bling.com.br/Api/v3/oauth/authorize',
    TOKEN_URL: 'https://bling.com.br/Api/v3/oauth/token',
    SYNC_TIMEZONE: 'America/Sao_Paulo',
    SYNC_HOUR: '6',
    TOKEN_MIN_VALIDITY_SECONDS: 60,
    OAUTH_STATE_TTL_SECONDS: 600
  });

  var SENSITIVE_KEYS = Object.freeze([
    KEYS.BLING_CLIENT_ID,
    KEYS.BLING_CLIENT_SECRET,
    KEYS.BLING_ACCESS_TOKEN,
    KEYS.BLING_REFRESH_TOKEN,
    KEYS.BLING_OAUTH_STATE_HASH
  ]);

  var OAUTH_SETUP_KEYS = Object.freeze([
    KEYS.BLING_CLIENT_ID,
    KEYS.BLING_CLIENT_SECRET,
    KEYS.BLING_REDIRECT_URI
  ]);

  var INTERNAL_KEYS = Object.freeze([
    KEYS.BLING_OAUTH_STATE_HASH,
    KEYS.BLING_OAUTH_STATE_EXPIRES_AT
  ]);

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function isSensitiveKey(key) {
    return SENSITIVE_KEYS.indexOf(key) >= 0;
  }

  function getPublicValue(key, fallbackValue) {
    if (isSensitiveKey(key)) {
      throw new Error('Acesso público bloqueado para propriedade sensível: ' + key);
    }
    var value = properties_().getProperty(key);
    return value === null || value === '' ? fallbackValue : value;
  }

  function requirePublicValue(key) {
    var value = getPublicValue(key, null);
    if (!value) {
      throw new Error('Configuração obrigatória ausente: ' + key);
    }
    return value;
  }

  function validate() {
    var props = properties_();
    var missing = OAUTH_SETUP_KEYS.filter(function (key) {
      return !props.getProperty(key);
    });
    var invalid = [];
    var syncHour = Number(getPublicValue(KEYS.SYNC_HOUR, DEFAULTS.SYNC_HOUR));
    var redirectUri = props.getProperty(KEYS.BLING_REDIRECT_URI);

    if (!Number.isInteger(syncHour) || syncHour < 0 || syncHour > 23) {
      invalid.push(KEYS.SYNC_HOUR);
    }
    if (redirectUri && redirectUri.indexOf('https://') !== 0) {
      invalid.push(KEYS.BLING_REDIRECT_URI);
    }

    return {
      valid: missing.length === 0 && invalid.length === 0,
      missing: missing,
      invalid: invalid
    };
  }

  function getPublicSnapshot() {
    var props = properties_();
    var present = {};
    Object.keys(KEYS).forEach(function (name) {
      var key = KEYS[name];
      if (INTERNAL_KEYS.indexOf(key) < 0) {
        present[key] = Boolean(props.getProperty(key));
      }
    });

    return {
      apiBaseUrl: DEFAULTS.API_BASE_URL,
      syncTimezone: getPublicValue(KEYS.SYNC_TIMEZONE, DEFAULTS.SYNC_TIMEZONE),
      syncHour: Number(getPublicValue(KEYS.SYNC_HOUR, DEFAULTS.SYNC_HOUR)),
      configuredProperties: present,
      validation: validate()
    };
  }

  return Object.freeze({
    KEYS: KEYS,
    DEFAULTS: DEFAULTS,
    getPublicValue: getPublicValue,
    requirePublicValue: requirePublicValue,
    getPublicSnapshot: getPublicSnapshot,
    isSensitiveKey: isSensitiveKey,
    validate: validate
  });
})();
