var PRAHealthService = (function () {
  'use strict';

  function getStatus() {
    var configuration = PRAConfig.getPublicSnapshot();
    return {
      application: 'pratearts-analytics-api',
      status: 'ok',
      runtime: 'Google Apps Script V8',
      blingConfigured: PRABlingClient.isConfigured(),
      configuration: configuration
    };
  }

  return Object.freeze({ getStatus: getStatus });
})();
