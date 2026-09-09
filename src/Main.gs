/**
 * Ponto de entrada manual para validar a instalação sem expor segredos.
 * @return {Object} Estado público e seguro da aplicação.
 */
function healthCheck() {
  return PRAHealthService.getStatus();
}

/**
 * Gera uma URL temporária e de uso único para autorizar o aplicativo no Bling.
 * @return {Object} URL, expiração e redirect URI configurado; nunca retorna segredos.
 */
function getBlingAuthorizationUrl() {
  return PRAOAuthService.createAuthorizationRequest();
}

/**
 * Ponto de entrada do gatilho diário. A sincronização será implementada
 * nas histórias de coleta; por enquanto retorna um estado explícito.
 * @return {Object} Resultado do disparo.
 */
function runDailySync() {
  return PRADailySyncJob.run();
}
