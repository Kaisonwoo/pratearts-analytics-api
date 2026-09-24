var PRAReportCsvService = (function () {
  'use strict';

  // Only fields already present in the read-only report contract may be exported.
  var COLUMNS = Object.freeze({
    kpis: [['valid_orders', 'validOrders'], ['items_quantity', 'itemsQuantity'],
      ['revenue', 'revenue'], ['average_ticket', 'averageTicket']],
    trend: [['period', 'period'], ['valid_orders', 'validOrders'],
      ['items_quantity', 'itemsQuantity'], ['revenue', 'revenue'],
      ['average_ticket', 'averageTicket']],
    products: [['position', 'position'], ['view', 'view'], ['product_id', 'productId'],
      ['sku', 'sku'], ['supplier_id', 'supplierId'], ['name', 'name'],
      ['quantity', 'quantity'], ['revenue', 'revenue'], ['orders_count', 'ordersCount']],
    variations: [['position', 'position'], ['view', 'view'], ['product_id', 'productId'],
      ['sku', 'sku'], ['supplier_id', 'supplierId'], ['name', 'name'],
      ['quantity', 'quantity'], ['revenue', 'revenue'], ['orders_count', 'ordersCount']],
    suppliers: [['position', 'position'], ['supplier_id', 'supplierId'],
      ['known_products_count', 'knownProductsCount'], ['quantity', 'quantity'],
      ['revenue', 'revenue']]
  });

  function cell_(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (value === null || typeof value === 'undefined') return '""';
    var text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
    // Spreadsheet programs can execute formula-like strings on CSV import.
    if (/^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text)) {
      text = '\t' + text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function serialize(resource, data) {
    var columns = COLUMNS[resource];
    if (!columns || !data) throw new Error('Recurso CSV indisponível.');
    var rows = resource === 'kpis' ? [data.kpis] : data[resource];
    if (!Array.isArray(rows) || rows.some(function (row) { return !row; })) {
      throw new Error('Resposta CSV inválida.');
    }
    var header = columns.map(function (column) { return cell_(column[0]); }).join(',');
    var lines = rows.map(function (row) {
      return columns.map(function (column) { return cell_(row[column[1]]); }).join(',');
    });
    return '\uFEFF' + [header].concat(lines).join('\r\n') + '\r\n';
  }

  return Object.freeze({ serialize: serialize });
})();
