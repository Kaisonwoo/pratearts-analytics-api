var PRAOAuthService = (function () {
  'use strict';

  function encodeQuery_(values) {
    return Object.keys(values).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]);
    }).join('&');
  }

  function createState_() {
    return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  }

  function hashState_(state) {
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(state),
      Utilities.Charset.UTF_8
    );
    return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
  }

  function safeFailure_(code, message) {
    return {
      ok: false,
      code: code,
      message: message
    };
  }

  function createAuthorizationRequest() {
    var validation = PRAConfig.validate();
    if (!validation.valid) {
      throw new Error(
        'Configuração OAuth incompleta. Revise as propriedades: ' +
        validation.missing.concat(validation.invalid).join(', ')
      );
    }

    var credentials = PRASecrets.getClientCredentials();
    var state = createState_();
    var expiresAt = Date.now() + PRAConfig.DEFAULTS.OAUTH_STATE_TTL_SECONDS * 1000;
    PRASecrets.saveOAuthState(hashState_(state), expiresAt);

    return {
      authorizationUrl: PRAConfig.DEFAULTS.AUTHORIZATION_URL + '?' + encodeQuery_({
        response_type: 'code',
        client_id: credentials.clientId,
        state: state
      }),
      expiresAt: expiresAt,
      redirectUri: PRAConfig.getPublicValue(PRAConfig.KEYS.BLING_REDIRECT_URI, null)
    };
  }

  function requestToken_(payload, rejectionEvent) {
    var credentials = PRASecrets.getClientCredentials();
    var basicCredentials = Utilities.base64Encode(
      credentials.clientId + ':' + credentials.clientSecret
    );
    var response = UrlFetchApp.fetch(PRAConfig.DEFAULTS.TOKEN_URL, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        Authorization: 'Basic ' + basicCredentials,
        Accept: 'application/json',
        'enable-jwt': '1'
      },
      payload: payload,
      muteHttpExceptions: true
    });
    var statusCode = response.getResponseCode();
    var body;

    try {
      body = JSON.parse(response.getContentText() || '{}');
    } catch (error) {
      throw new Error('Resposta inválida do servidor de autorização do Bling.');
    }

    if (statusCode < 200 || statusCode >= 300) {
      var candidate = body && body.error ? String(body.error) : 'http_' + statusCode;
      var oauthCode = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : 'oauth_error';
      PRALogger.warn(rejectionEvent, {
        statusCode: statusCode,
        oauthError: oauthCode
      });
      throw new Error('O Bling recusou a solicitação OAuth: ' + oauthCode + '.');
    }

    return body;
  }

  function exchangeAuthorizationCode_(code) {
    var body = requestToken_({
      grant_type: 'authorization_code',
      code: code
    }, 'bling_oauth_token_rejected');
    return PRASecrets.saveTokenResponse(body);
  }

  function refreshAccessToken(minValiditySeconds) {
    try {
      var result = PRASecrets.refreshTokensAtomically(
        minValiditySeconds,
        function (currentRefreshToken) {
          return requestToken_({
            grant_type: 'refresh_token',
            refresh_token: currentRefreshToken
          }, 'bling_oauth_refresh_rejected');
        }
      );

      PRALogger.info(
        result.refreshed ? 'bling_oauth_token_refreshed' : 'bling_oauth_refresh_not_required',
        {
          refreshed: result.refreshed,
          expiresAt: result.tokenStatus.expiresAt
        }
      );
      return {
        ok: true,
        code: result.refreshed ? 'token_refreshed' : 'token_still_valid',
        refreshed: result.refreshed,
        tokenStatus: result.tokenStatus
      };
    } catch (error) {
      PRALogger.error('bling_oauth_refresh_failed', { reason: 'refresh_failed' });
      return safeFailure_(
        'refresh_failed',
        'Não foi possível renovar o acesso ao Bling. O último estado consistente foi preservado.'
      );
    }
  }

  function getValidAccessToken(minValiditySeconds) {
    var result = refreshAccessToken(minValiditySeconds);
    if (!result.ok) {
      throw new Error('Não foi possível obter um access token válido do Bling.');
    }

    var snapshot = PRASecrets.getTokenSnapshot();
    if (!snapshot.accessToken || !PRASecrets.hasUsableAccessToken(minValiditySeconds)) {
      throw new Error('Access token válido não está disponível.');
    }
    return snapshot.accessToken;
  }

  function handleCallback(parameters) {
    var input = parameters || {};
    if (!input.state) {
      return safeFailure_(
        'invalid_state',
        'Não foi possível validar a autorização. Gere um novo link e tente novamente.'
      );
    }

    var stateResult = PRASecrets.consumeOAuthState(hashState_(input.state));
    if (!stateResult.valid) {
      return safeFailure_(
        'invalid_state',
        'O link de autorização expirou ou já foi utilizado. Gere um novo link.'
      );
    }

    if (input.error) {
      return safeFailure_(
        'authorization_denied',
        'A autorização foi recusada no Bling. Nenhum token foi armazenado.'
      );
    }
    if (!input.code) {
      return safeFailure_(
        'missing_code',
        'O Bling não retornou o código de autorização. Gere um novo link.'
      );
    }

    try {
      var tokenStatus = exchangeAuthorizationCode_(String(input.code));
      return {
        ok: true,
        code: 'authorized',
        message: 'Autorização concluída. Os tokens foram armazenados com segurança.',
        tokenStatus: tokenStatus
      };
    } catch (error) {
      PRALogger.error('bling_oauth_callback_failed', { reason: 'token_exchange_failed' });
      return safeFailure_(
        'token_exchange_failed',
        'Não foi possível concluir a autorização. Gere um novo link e tente novamente.'
      );
    }
  }

  return Object.freeze({
    createAuthorizationRequest: createAuthorizationRequest,
    handleCallback: handleCallback,
    refreshAccessToken: refreshAccessToken,
    getValidAccessToken: getValidAccessToken
  });
})();
