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
  return PRAHealthService.checkBlingConnectivity();
}

/**
 * Ponto de entrada do gatilho diário. A sincronização será implementada
 * nas histórias de coleta; por enquanto retorna um estado explícito.
 * @return {Object} Resultado do disparo.
 */
function runDailySync() {
  return PRADailySyncJob.run();
}

/**
 * Executa ou retoma a carga inicial de pedidos atendidos para um período.
 * O armazenamento da página pode ser fornecido pelo próximo estágio por lote;
 * o checkpoint permanece em Script Properties e não contém pedidos.
 * @param {string} startDate Data inicial no formato YYYY-MM-DD.
 * @param {string} endDate Data final no formato YYYY-MM-DD.
 * @param {boolean} reset Reinicia o checkpoint do mesmo período quando true.
 * @return {Object} Metadados seguros da execução.
 */
function runInitialOrdersLoad(startDate, endDate, reset) {
  return PRAOrdersInitialLoad.run({
    startDate: startDate,
    endDate: endDate,
    reset: Boolean(reset),
    onPage: function (orders, page, context) {
      return PRAOrderDetailsQueue.enqueuePage(orders, page, context);
    }
  });
}

/**
 * Processa um lote retomável de detalhes dos pedidos enfileirados pela carga.
 * O retorno contém somente contagens e metadados operacionais seguros.
 * @param {number} maxOrders Quantidade máxima opcional de pedidos no lote.
 * @return {Object} Resumo seguro da execução.
 */
function runOrderDetailsBatch(maxOrders) {
  return PRAOrderDetailsJob.run({ maxOrders: maxOrders });
}

/**
 * Executa ou retoma a reconciliação completa do catálogo de produtos.
 * Persiste IDs, SKUs e relações pai/filho sem expor o catálogo nos logs.
 * @param {boolean} reset Reinicia o checkpoint da reconciliação quando true.
 * @return {Object} Resumo operacional seguro da execução.
 */
function runProductsSync(reset) {
  return PRAProductsSyncJob.run({ reset: Boolean(reset) });
}

/**
 * Executa ou retoma a reconciliação completa dos vínculos produto-fornecedor.
 * Sinaliza ausência e multiplicidade e aplica a regra configurada de fornecedor principal.
 * @param {boolean} reset Reinicia o checkpoint da reconciliação quando true.
 * @return {Object} Resumo operacional seguro da execução.
 */
function runProductSuppliersSync(reset) {
  return PRAProductSuppliersSyncJob.run({ reset: Boolean(reset) });
}

/**
 * Provisiona e valida as abas das camadas raw, staging, mart e logs.
 * @return {Object} Resumo seguro do esquema provisionado.
 */
function provisionDataLayers() {
  return PRADataLayerProvisioner.run();
}
