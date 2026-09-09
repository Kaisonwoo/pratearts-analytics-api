function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderOAuthPage_(title, message, authorizationUrl) {
  var link = authorizationUrl
    ? '<p><a href="' + escapeHtml_(authorizationUrl) + '" target="_top">Autorizar no Bling</a></p>'
    : '';
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    escapeHtml_(title) + '</title></head><body><main><h1>' +
    escapeHtml_(title) + '</h1><p>' + escapeHtml_(message) + '</p>' + link +
    '</main></body></html>'
  ).setTitle(title);
}

function renderAuthorizationStart_() {
  try {
    var request = PRAOAuthService.createAuthorizationRequest();
    return renderOAuthPage_(
      'Autorizar Pratearts Analytics',
      'O link é temporário e pode ser utilizado somente uma vez.',
      request.authorizationUrl
    );
  } catch (error) {
    return renderOAuthPage_(
      'Configuração incompleta',
      'Revise as Script Properties do OAuth antes de tentar novamente.'
    );
  }
}

function renderAuthorizationCallback_(parameters) {
  var result = PRAOAuthService.handleCallback(parameters);
  return renderOAuthPage_(
    result.ok ? 'Autorização concluída' : 'Autorização não concluída',
    result.message
  );
}

/**
 * Endpoint de saúde e entrada do OAuth. Nenhuma resposta retorna segredos.
 * @param {Object} event Evento HTTP do Apps Script.
 * @return {GoogleAppsScript.Content.TextOutput|GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(event) {
  var parameters = event && event.parameter ? event.parameter : {};
  if (parameters.action === 'authorize') {
    return renderAuthorizationStart_();
  }
  if (parameters.code || parameters.error || parameters.state) {
    return renderAuthorizationCallback_(parameters);
  }
  return ContentService
    .createTextOutput(JSON.stringify(PRAHealthService.getStatus()))
    .setMimeType(ContentService.MimeType.JSON);
}
