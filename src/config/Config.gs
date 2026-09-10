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
    BLING_REQUESTS_PER_SECOND: 'BLING_REQUESTS_PER_SECOND',
    BLING_PAGE_SIZE: 'BLING_PAGE_SIZE',
    BLING_MAX_RETRIES: 'BLING_MAX_RETRIES',
    BLING_BACKOFF_BASE_MS: 'BLING_BACKOFF_BASE_MS',
    BLING_BACKOFF_MAX_MS: 'BLING_BACKOFF_MAX_MS',
    BLING_MAX_PAGES: 'BLING_MAX_PAGES',
    BLING_NEXT_REQUEST_AT: 'BLING_NEXT_REQUEST_AT',
    BLING_LAST_SUCCESS_AT: 'BLING_LAST_SUCCESS_AT',
    BLING_LAST_SUCCESS_CORRELATION_ID: 'BLING_LAST_SUCCESS_CORRELATION_ID',
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
    OAUTH_STATE_TTL_SECONDS: 600,
    BLING_REQUESTS_PER_SECOND: 3,
    BLING_PAGE_SIZE: 100,
    BLING_MAX_RETRIES: 3,
    BLING_BACKOFF_BASE_MS: 1000,
    BLING_BACKOFF_MAX_MS: 8000,
    BLING_MAX_PAGES: 1000
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
    KEYS.BLING_OAUTH_STATE_EXPIRES_AT,
    KEYS.BLING_NEXT_REQUEST_AT,
    KEYS.BLING_LAST_SUCCESS_AT,
    KEYS.BLING_LAST_SUCCESS_CORRELATION_ID
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

  function readInteger_(key, fallbackValue) {
    var raw = getPublicValue(key, String(fallbackValue));
    var value = Number(raw);
    return Number.isInteger(value) ? value : NaN;
  }

  function getRequestPolicy() {
    return {
      requestsPerSecond: readInteger_(
        KEYS.BLING_REQUESTS_PER_SECOND,
        DEFAULTS.BLING_REQUESTS_PER_SECOND
      ),
      pageSize: readInteger_(KEYS.BLING_PAGE_SIZE, DEFAULTS.BLING_PAGE_SIZE),
      maxRetries: readInteger_(KEYS.BLING_MAX_RETRIES, DEFAULTS.BLING_MAX_RETRIES),
      backoffBaseMs: readInteger_(
        KEYS.BLING_BACKOFF_BASE_MS,
        DEFAULTS.BLING_BACKOFF_BASE_MS
      ),
      backoffMaxMs: readInteger_(
        KEYS.BLING_BACKOFF_MAX_MS,
        DEFAULTS.BLING_BACKOFF_MAX_MS
      ),
      maxPages: readInteger_(KEYS.BLING_MAX_PAGES, DEFAULTS.BLING_MAX_PAGES)
    };
  }

  function validate() {
    var props = properties_();
    var missing = OAUTH_SETUP_KEYS.filter(function (key) {
      return !props.getProperty(key);
    });
    var invalid = [];
    var syncHour = Number(getPublicValue(KEYS.SYNC_HOUR, DEFAULTS.SYNC_HOUR));
    var redirectUri = props.getProperty(KEYS.BLING_REDIRECT_URI);
    var policy = getRequestPolicy();

    if (!Number.isInteger(syncHour) || syncHour < 0 || syncHour > 23) {
      invalid.push(KEYS.SYNC_HOUR);
    }
    if (redirectUri && redirectUri.indexOf('https://') !== 0) {
      invalid.push(KEYS.BLING_REDIRECT_URI);
    }
    if (!Number.isInteger(policy.requestsPerSecond) ||
        policy.requestsPerSecond < 1 || policy.requestsPerSecond > 3) {
      invalid.push(KEYS.BLING_REQUESTS_PER_SECOND);
    }
    if (!Number.isInteger(policy.pageSize) || policy.pageSize < 1 || policy.pageSize > 100) {
      invalid.push(KEYS.BLING_PAGE_SIZE);
    }
    if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 5) {
      invalid.push(KEYS.BLING_MAX_RETRIES);
    }
    if (!Number.isInteger(policy.backoffBaseMs) ||
        policy.backoffBaseMs < 250 || policy.backoffBaseMs > 10000) {
      invalid.push(KEYS.BLING_BACKOFF_BASE_MS);
    }
    if (!Number.isInteger(policy.backoffMaxMs) ||
        policy.backoffMaxMs < policy.backoffBaseMs || policy.backoffMaxMs > 30000) {
      invalid.push(KEYS.BLING_BACKOFF_MAX_MS);
    }
    if (!Number.isInteger(policy.maxPages) || policy.maxPages < 1 || policy.maxPages > 10000) {
      invalid.push(KEYS.BLING_MAX_PAGES);
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
      requestPolicy: getRequestPolicy(),
      configuredProperties: present,
      validation: validate()
    };
  }

  return Object.freeze({
    KEYS: KEYS,
    DEFAULTS: DEFAULTS,
    getPublicValue: getPublicValue,
    requirePublicValue: requirePublicValue,
    getRequestPolicy: getRequestPolicy,
    getPublicSnapshot: getPublicSnapshot,
    isSensitiveKey: isSensitiveKey,
    validate: validate
  });
})();
