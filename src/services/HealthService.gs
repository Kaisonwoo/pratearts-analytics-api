var PRAHealthService = (function () {
  'use strict';

  function getStatus() {
    var configuration = PRAConfig.getPublicSnapshot();
    var blingSecurity = PRABlingClient.getSecurityStatus();
    return {
      application: 'pratearts-analytics-api',
      status: 'ok',
      runtime: 'Google Apps Script V8',
      blingConfigured: blingSecurity.configured,
      blingAuthenticated: blingSecurity.authenticated,
      tokenStatus: blingSecurity.token,
      configuration: configuration
    };
  }

  return Object.freeze({ getStatus: getStatus });
})();
