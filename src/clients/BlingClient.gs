var PRABlingClient = (function () {
  'use strict';

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

  return Object.freeze({
    isConfigured: isConfigured,
    isAuthenticated: isAuthenticated,
    getSecurityStatus: getSecurityStatus
  });
})();
