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

function renderDashboardPage_() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Pratearts Analytics')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function apiEnvelope_(data, resource) {
  return {
    data: data,
    meta: {
      contractVersion: '1.0',
      generatedAt: new Date().toISOString(),
      source: 'runtime'
    },
    filtersApplied: { resource: resource },
    errors: []
  };
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeApiRequest_(parameters) {
  var resource = String(parameters.resource || '').toLowerCase();
  if (resource === 'health') {
    return apiEnvelope_(PRAHealthService.getStatus(), resource);
  }
  if (resource === 'dashboard') {
    return PRAReportService.execute(parameters);
  }
  return {
    data: null,
    meta: {
      contractVersion: '1.0',
      generatedAt: new Date().toISOString(),
      source: 'runtime'
    },
    filtersApplied: { resource: resource || null },
    errors: [{
      code: 'report_unknown_resource',
      message: 'O recurso solicitado não existe.'
    }]
  };
}

/**
 * Entrada do OAuth, dashboard e API de relatórios.
 * Sem resource ou view, preserva o endpoint de saúde legado.
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
  if (parameters.view === 'dashboard') {
    return renderDashboardPage_();
  }
  if (parameters.resource) {
    return jsonOutput_(routeApiRequest_(parameters));
  }
  return jsonOutput_(PRAHealthService.getStatus());
}
