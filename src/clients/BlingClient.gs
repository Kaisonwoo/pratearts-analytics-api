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

  return Object.freeze({
    isConfigured: isConfigured,
    isAuthenticated: isAuthenticated,
    getSecurityStatus: getSecurityStatus,
    refreshAuthentication: refreshAuthentication,
    getAccessToken: getAccessToken
  });
})();
