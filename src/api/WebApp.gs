/**
 * Endpoint mínimo de saúde. Não retorna valores de propriedades sensíveis.
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify(PRAHealthService.getStatus()))
    .setMimeType(ContentService.MimeType.JSON);
}
