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
 * Renova o access token somente quando a validade restante está abaixo
 * da margem segura. A resposta contém apenas indicadores públicos.
 * @return {Object} Resultado seguro da renovação.
 */
function refreshBlingAccessToken() {
  return PRABlingClient.refreshAuthentication();
}

/**
 * Faz uma consulta mínima e somente leitura para validar o acesso à API.
 * Retorna apenas metadados seguros; nenhum produto ou token é exposto.
 * @return {Object} Resultado seguro do teste de conectividade.
 */
function testBlingApiConnection() {
  return PRABlingClient.probe();
}

/**
 * Ponto de entrada do gatilho diário. A sincronização será implementada
 * nas histórias de coleta; por enquanto retorna um estado explícito.
 * @return {Object} Resultado do disparo.
 */
function runDailySync() {
  return PRADailySyncJob.run();
}
