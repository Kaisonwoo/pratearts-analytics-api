var PRASecrets = (function () {
  'use strict';

  var TOKEN_KEYS = Object.freeze([
    PRAConfig.KEYS.BLING_ACCESS_TOKEN,
    PRAConfig.KEYS.BLING_REFRESH_TOKEN,
    PRAConfig.KEYS.BLING_TOKEN_EXPIRES_AT
  ]);

  var OAUTH_STATE_KEYS = Object.freeze([
    PRAConfig.KEYS.BLING_OAUTH_STATE_HASH,
    PRAConfig.KEYS.BLING_OAUTH_STATE_EXPIRES_AT
  ]);

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function requireSecret_(key) {
    var value = properties_().getProperty(key);
    if (!value) {
      throw new Error('Credencial obrigatória ausente: ' + key);
    }
    return value;
  }

  function withLock_(operation) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return operation();
    } finally {
      lock.releaseLock();
    }
  }

  function getClientCredentials() {
    return {
      clientId: requireSecret_(PRAConfig.KEYS.BLING_CLIENT_ID),
      clientSecret: requireSecret_(PRAConfig.KEYS.BLING_CLIENT_SECRET)
    };
  }

  function getTokenSnapshot() {
    var props = properties_();
    return {
      accessToken: props.getProperty(PRAConfig.KEYS.BLING_ACCESS_TOKEN),
      refreshToken: props.getProperty(PRAConfig.KEYS.BLING_REFRESH_TOKEN),
      expiresAt: Number(props.getProperty(PRAConfig.KEYS.BLING_TOKEN_EXPIRES_AT) || 0)
    };
  }

  function getTokenStatus() {
    var snapshot = getTokenSnapshot();
    var now = Date.now();
    return {
      accessTokenPresent: Boolean(snapshot.accessToken),
      refreshTokenPresent: Boolean(snapshot.refreshToken),
      expiresAt: snapshot.expiresAt || null,
      expired: snapshot.expiresAt > 0 ? snapshot.expiresAt <= now : true
    };
  }

  function hasUsableAccessToken(minValiditySeconds) {
    var snapshot = getTokenSnapshot();
    var minimum = Number(minValiditySeconds);
    if (!Number.isFinite(minimum) || minimum < 0) {
      minimum = PRAConfig.DEFAULTS.TOKEN_MIN_VALIDITY_SECONDS;
    }
    return Boolean(
      snapshot.accessToken &&
      snapshot.expiresAt > Date.now() + minimum * 1000
    );
  }

  function saveTokenResponse(tokenResponse) {
    var response = tokenResponse || {};
    var expiresIn = Number(response.expires_in);

    if (typeof response.access_token !== 'string' || !response.access_token) {
      throw new Error('Resposta OAuth inválida: access_token ausente.');
    }
    if (typeof response.refresh_token !== 'string' || !response.refresh_token) {
      throw new Error('Resposta OAuth inválida: refresh_token ausente.');
    }
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Resposta OAuth inválida: expires_in inválido.');
    }
    if (response.token_type && String(response.token_type).toLowerCase() !== 'bearer') {
      throw new Error('Resposta OAuth inválida: token_type não suportado.');
    }

    var values = {};
    values[PRAConfig.KEYS.BLING_ACCESS_TOKEN] = response.access_token;
    values[PRAConfig.KEYS.BLING_REFRESH_TOKEN] = response.refresh_token;
    values[PRAConfig.KEYS.BLING_TOKEN_EXPIRES_AT] = String(Date.now() + expiresIn * 1000);

    withLock_(function () {
      properties_().setProperties(values, false);
    });
    return getTokenStatus();
  }

  function clearTokens() {
    withLock_(function () {
      var props = properties_();
      TOKEN_KEYS.forEach(function (key) {
        props.deleteProperty(key);
      });
    });
    return getTokenStatus();
  }

  function constantTimeEquals_(left, right) {
    var a = String(left || '');
    var b = String(right || '');
    var difference = a.length ^ b.length;
    var length = Math.max(a.length, b.length);

    for (var index = 0; index < length; index += 1) {
      difference |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0) ^
        (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
    }
    return difference === 0;
  }

  function saveOAuthState(stateHash, expiresAt) {
    var expiration = Number(expiresAt);
    if (typeof stateHash !== 'string' || !stateHash) {
      throw new Error('Estado OAuth inválido: hash ausente.');
    }
    if (!Number.isFinite(expiration) || expiration <= Date.now()) {
      throw new Error('Estado OAuth inválido: expiração inválida.');
    }

    var values = {};
    values[PRAConfig.KEYS.BLING_OAUTH_STATE_HASH] = stateHash;
    values[PRAConfig.KEYS.BLING_OAUTH_STATE_EXPIRES_AT] = String(expiration);
    withLock_(function () {
      properties_().setProperties(values, false);
    });
  }

  function consumeOAuthState(candidateHash) {
    return withLock_(function () {
      var props = properties_();
      var expectedHash = props.getProperty(PRAConfig.KEYS.BLING_OAUTH_STATE_HASH);
      var expiresAt = Number(props.getProperty(PRAConfig.KEYS.BLING_OAUTH_STATE_EXPIRES_AT) || 0);

      OAUTH_STATE_KEYS.forEach(function (key) {
        props.deleteProperty(key);
      });

      if (!expectedHash || !expiresAt) {
        return { valid: false, reason: 'missing' };
      }
      if (expiresAt <= Date.now()) {
        return { valid: false, reason: 'expired' };
      }
      if (!constantTimeEquals_(expectedHash, candidateHash)) {
        return { valid: false, reason: 'mismatch' };
      }
      return { valid: true, reason: null };
    });
  }

  return Object.freeze({
    getClientCredentials: getClientCredentials,
    getTokenSnapshot: getTokenSnapshot,
    getTokenStatus: getTokenStatus,
    hasUsableAccessToken: hasUsableAccessToken,
    saveTokenResponse: saveTokenResponse,
    clearTokens: clearTokens,
    saveOAuthState: saveOAuthState,
    consumeOAuthState: consumeOAuthState
  });
})();
