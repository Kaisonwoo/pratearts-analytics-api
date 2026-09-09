var PRABlingClient = (function () {
  'use strict';

  /**
   * Informa se as propriedades mínimas existem sem retornar seus valores.
   * A autenticação e as requisições serão implementadas no Sprint 1.
   * @return {boolean}
   */
  function isConfigured() {
    var snapshot = PRAConfig.getPublicSnapshot();
    return Boolean(
      snapshot.configuredProperties.BLING_CLIENT_ID &&
      snapshot.configuredProperties.BLING_CLIENT_SECRET
    );
  }

  return Object.freeze({
    isConfigured: isConfigured
  });
})();
