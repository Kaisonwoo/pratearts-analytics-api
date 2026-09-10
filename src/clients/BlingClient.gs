var PRABlingClient = (function () {
  'use strict';

  var SAFE_OPERATION = /^[A-Za-z0-9_.-]{1,80}$/;
  var SAFE_PATH = /^\/[A-Za-z0-9._~\/-]*$/;
  var ERROR_MESSAGES = Object.freeze({
    bad_request: 'A API do Bling recusou os parâmetros da solicitação.',
    unauthorized: 'A autorização do Bling não é válida. Autorize novamente.',
    forbidden: 'O aplicativo não possui permissão para consultar esse recurso.',
    not_found: 'O recurso solicitado não foi encontrado no Bling.',
    conflict: 'O Bling recusou a solicitação por conflito.',
    validation_error: 'A API do Bling recusou a validação da solicitação.',
    rate_limited: 'O limite temporário de chamadas do Bling foi atingido.',
    service_unavailable: 'A API do Bling está temporariamente indisponível.',
    invalid_response: 'A API do Bling retornou uma resposta inesperada.',
    network_error: 'Não foi possível comunicar com a API do Bling.',
    pagination_limit: 'A paginação atingiu o limite seguro antes de terminar.',
    http_error: 'A API do Bling recusou a solicitação.'
  });

  function isConfigured() {
    return PRAConfig.validate().valid;
  }

  function isAuthenticated() {
    return PRASecrets.hasUsableAccessToken(
      PRAConfig.DEFAULTS.TOKEN_MIN_VALIDITY_SECONDS
    );
  }

  function getSecurityStatus() {
    return {
      configured: isConfigured(),
      authenticated: isAuthenticated(),
      token: PRASecrets.getTokenStatus()
    };
  }

  function refreshAuthentication() {
    return PRAOAuthService.refreshAccessToken(
      PRAConfig.DEFAULTS.TOKEN_MIN_VALIDITY_SECONDS
    );
  }

  function getAccessToken() {
    return PRAOAuthService.getValidAccessToken(
      PRAConfig.DEFAULTS.TOKEN_MIN_VALIDITY_SECONDS
    );
  }

  function createCorrelationId_() {
    return Utilities.getUuid();
  }

  function normalizeOperation_(operation) {
    var candidate = String(operation || 'bling.get');
    return SAFE_OPERATION.test(candidate) ? candidate : 'bling.get';
  }

  function validatePath_(path) {
    var candidate = String(path || '');
    if (!SAFE_PATH.test(candidate) || candidate.indexOf('//') >= 0) {
      throw new Error('Caminho relativo inválido para a API do Bling.');
    }
    return candidate;
  }

  function encodeQuery_(query) {
    var pairs = [];
    Object.keys(query || {}).sort().forEach(function (key) {
      var values = Array.isArray(query[key]) ? query[key] : [query[key]];
      values.forEach(function (value) {
        if (value !== null && typeof value !== 'undefined') {
          pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
        }
      });
    });
    return pairs.length ? '?' + pairs.join('&') : '';
  }

  function errorCodeForStatus_(statusCode) {
    if (statusCode === 400) return 'bad_request';
    if (statusCode === 401) return 'unauthorized';
    if (statusCode === 403) return 'forbidden';
    if (statusCode === 404) return 'not_found';
    if (statusCode === 409) return 'conflict';
    if (statusCode === 422) return 'validation_error';
    if (statusCode === 429) return 'rate_limited';
    if (statusCode >= 500) return 'service_unavailable';
    return 'http_error';
  }

  function failure_(code, statusCode, correlationId, durationMs, retryable, attempts) {
    return {
      ok: false,
      statusCode: statusCode,
      correlationId: correlationId,
      durationMs: durationMs,
      attempts: attempts || 1,
      error: {
        code: code,
        message: ERROR_MESSAGES[code] || ERROR_MESSAGES.http_error,
        retryable: Boolean(retryable)
      }
    };
  }

  function logResult_(level, eventName, context) {
    var method = level === 'error' ? PRALogger.error :
      (level === 'warn' ? PRALogger.warn : PRALogger.info);
    method(eventName, context);
  }

  function get(path, query, options) {
    var startedAt = Date.now();
    var correlationId = createCorrelationId_();
    var operation = normalizeOperation_(options && options.operation);
    var policy = PRAConfig.getRequestPolicy();
    var maxAttempts = policy.maxRetries + 1;
    var attempt;

    try {
      var safePath = validatePath_(path);
      var url = PRAConfig.DEFAULTS.API_BASE_URL + safePath + encodeQuery_(query);
      var accessToken = getAccessToken();

      for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          PRAResilience.acquireRateLimitSlot();
          var response = UrlFetchApp.fetch(url, {
            method: 'get',
            headers: {
              Accept: 'application/json',
              Authorization: 'Bearer ' + accessToken,
              'X-Correlation-Id': correlationId
            },
            muteHttpExceptions: true
          });
          var statusCode = response.getResponseCode();
          var durationMs = Date.now() - startedAt;

          if (statusCode < 200 || statusCode >= 300) {
            var errorCode = errorCodeForStatus_(statusCode);
            var retryable = PRAResilience.isRetryableStatus(statusCode, false);
            var failed = failure_(
              errorCode,
              statusCode,
              correlationId,
              durationMs,
              retryable,
              attempt
            );

            if (retryable && attempt < maxAttempts) {
              var delayMs = PRAResilience.waitBeforeRetry(attempt);
              logResult_('warn', 'bling_http_retry_scheduled', {
                operation: operation,
                correlationId: correlationId,
                statusCode: statusCode,
                errorCode: errorCode,
                attempt: attempt,
                nextAttempt: attempt + 1,
                delayMs: delayMs
              });
              continue;
            }

            logResult_(statusCode >= 500 ? 'error' : 'warn', 'bling_http_failed', {
              operation: operation,
              correlationId: correlationId,
              statusCode: statusCode,
              durationMs: durationMs,
              errorCode: errorCode,
              retryable: retryable,
              attempts: attempt
            });
            return failed;
          }

          var body;
          try {
            body = JSON.parse(response.getContentText() || '{}');
          } catch (parseError) {
            var invalid = failure_(
              'invalid_response',
              statusCode,
              correlationId,
              durationMs,
              false,
              attempt
            );
            logResult_('error', 'bling_http_invalid_response', {
              operation: operation,
              correlationId: correlationId,
              statusCode: statusCode,
              durationMs: durationMs,
              attempts: attempt
            });
            return invalid;
          }

          var result = {
            ok: true,
            statusCode: statusCode,
            correlationId: correlationId,
            durationMs: durationMs,
            attempts: attempt,
            data: Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : null
          };
          logResult_('info', 'bling_http_succeeded', {
            operation: operation,
            correlationId: correlationId,
            statusCode: statusCode,
            durationMs: durationMs,
            attempts: attempt
          });
          return result;
        } catch (error) {
          var networkFailure = failure_(
            'network_error',
            null,
            correlationId,
            Date.now() - startedAt,
            true,
            attempt
          );

          if (attempt < maxAttempts) {
            var networkDelayMs = PRAResilience.waitBeforeRetry(attempt);
            logResult_('warn', 'bling_http_retry_scheduled', {
              operation: operation,
              correlationId: correlationId,
              statusCode: null,
              errorCode: networkFailure.error.code,
              attempt: attempt,
              nextAttempt: attempt + 1,
              delayMs: networkDelayMs
            });
            continue;
          }

          logResult_('error', 'bling_http_network_failed', {
            operation: operation,
            correlationId: correlationId,
            durationMs: networkFailure.durationMs,
            errorCode: networkFailure.error.code,
            retryable: true,
            attempts: attempt
          });
          return networkFailure;
        }
      }
    } catch (error) {
      var setupFailure = failure_(
        'network_error',
        null,
        correlationId,
        Date.now() - startedAt,
        false,
        1
      );
      logResult_('error', 'bling_http_setup_failed', {
        operation: operation,
        correlationId: correlationId,
        durationMs: setupFailure.durationMs,
        errorCode: setupFailure.error.code,
        retryable: false
      });
      return setupFailure;
    }
  }

  function positiveInteger_(value, fallbackValue) {
    var candidate = Number(value);
    return Number.isInteger(candidate) && candidate > 0 ? candidate : fallbackValue;
  }

  function getAllPages(path, query, options) {
    var startedAt = Date.now();
    var paginationId = createCorrelationId_();
    var settings = options || {};
    var operation = normalizeOperation_(settings.operation || 'bling.list');
    var policy = PRAConfig.getRequestPolicy();
    var baseQuery = Object.assign({}, query || {});
    var startPage = positiveInteger_(baseQuery.pagina, 1);
    var pageSize = positiveInteger_(settings.pageSize || baseQuery.limite, policy.pageSize);
    var maxPages = positiveInteger_(settings.maxPages, policy.maxPages);
    var page = startPage;
    var pagesFetched = 0;
    var totalAttempts = 0;
    var records = [];
    var lastStatusCode = null;

    pageSize = Math.min(pageSize, policy.pageSize);
    maxPages = Math.min(maxPages, policy.maxPages);
    delete baseQuery.pagina;
    delete baseQuery.limite;

    while (pagesFetched < maxPages) {
      var pageQuery = Object.assign({}, baseQuery, {
        pagina: page,
        limite: pageSize
      });
      var pageResult = get(path, pageQuery, {
        operation: operation + '.page'
      });
      totalAttempts += pageResult.attempts || 1;
      lastStatusCode = pageResult.statusCode;

      if (!pageResult.ok) {
        pageResult.pagination = {
          complete: false,
          startPage: startPage,
          failedPage: page,
          pagesFetched: pagesFetched,
          recordCount: records.length
        };
        return pageResult;
      }

      if (!Array.isArray(pageResult.data)) {
        var invalidPage = failure_(
          'invalid_response',
          pageResult.statusCode,
          paginationId,
          Date.now() - startedAt,
          false,
          totalAttempts
        );
        invalidPage.pagination = {
          complete: false,
          startPage: startPage,
          failedPage: page,
          pagesFetched: pagesFetched,
          recordCount: records.length
        };
        return invalidPage;
      }

      Array.prototype.push.apply(records, pageResult.data);
      pagesFetched += 1;

      if (pageResult.data.length < pageSize) {
        var completed = {
          ok: true,
          statusCode: lastStatusCode,
          correlationId: paginationId,
          durationMs: Date.now() - startedAt,
          attempts: totalAttempts,
          data: records,
          pagination: {
            complete: true,
            startPage: startPage,
            lastPage: page,
            pagesFetched: pagesFetched,
            pageSize: pageSize,
            recordCount: records.length
          }
        };
        logResult_('info', 'bling_pagination_succeeded', {
          operation: operation,
          correlationId: paginationId,
          pagesFetched: pagesFetched,
          recordCount: records.length,
          attempts: totalAttempts,
          durationMs: completed.durationMs
        });
        return completed;
      }

      page += 1;
    }

    var limited = failure_(
      'pagination_limit',
      lastStatusCode,
      paginationId,
      Date.now() - startedAt,
      false,
      totalAttempts
    );
    limited.pagination = {
      complete: false,
      startPage: startPage,
      nextPage: page,
      pagesFetched: pagesFetched,
      pageSize: pageSize,
      recordCount: records.length
    };
    logResult_('error', 'bling_pagination_limit_reached', {
      operation: operation,
      correlationId: paginationId,
      pagesFetched: pagesFetched,
      recordCount: records.length,
      attempts: totalAttempts
    });
    return limited;
  }

  function probe() {
    var result = get('/produtos', { pagina: 1, limite: 1 }, {
      operation: 'products.list.probe'
    });
    return {
      ok: result.ok,
      code: result.ok ? 'connected' : result.error.code,
      statusCode: result.statusCode,
      correlationId: result.correlationId,
      checkedAt: new Date().toISOString(),
      recordCount: result.ok && Array.isArray(result.data) ? result.data.length : 0
    };
  }

  return Object.freeze({
    isConfigured: isConfigured,
    isAuthenticated: isAuthenticated,
    getSecurityStatus: getSecurityStatus,
    refreshAuthentication: refreshAuthentication,
    getAccessToken: getAccessToken,
    get: get,
    getAllPages: getAllPages,
    probe: probe
  });
})();
