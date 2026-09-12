var PRAKpiService = (function () {
  'use strict';

  var CURRENCY_SCALE = 100;
  var QUANTITY_SCALE = 1000000;

  function isBlank_(value) {
    return value === '' || value === null || typeof value === 'undefined';
  }

  function finiteNumber_(value, fieldName, allowBlank) {
    if (isBlank_(value)) {
      if (allowBlank) return 0;
      throw new Error('Valor numérico obrigatório ausente em ' + fieldName + '.');
    }
    var candidate = Number(value);
    if (!Number.isFinite(candidate)) {
      throw new Error('Valor numérico inválido em ' + fieldName + '.');
    }
    return candidate;
  }

  function round_(value, scale) {
    var sign = value < 0 ? -1 : 1;
    var rounded = sign * Math.round((Math.abs(value) + 0.000000001) * scale) / scale;
    return rounded === 0 ? 0 : rounded;
  }

  function roundCurrency_(value) {
    return round_(value, CURRENCY_SCALE);
  }

  function calculateItemRevenue(quantity, unitValue, discountPercent) {
    var normalizedQuantity = finiteNumber_(quantity, 'quantity', false);
    var normalizedUnitValue = finiteNumber_(unitValue, 'unit_value', false);
    var normalizedDiscount = finiteNumber_(discountPercent, 'discount', true);

    if (normalizedUnitValue < 0) {
      throw new Error('unit_value não pode ser negativo.');
    }
    if (normalizedDiscount < 0 || normalizedDiscount > 100) {
      throw new Error('discount deve ser um percentual entre 0 e 100.');
    }

    var revenue = normalizedQuantity * normalizedUnitValue * (1 - normalizedDiscount / 100);
    if (!Number.isFinite(revenue)) {
      throw new Error('O faturamento calculado excede o intervalo numérico suportado.');
    }
    return roundCurrency_(revenue);
  }

  function dateKey_(value) {
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    var candidate = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return '';
    var parsed = Date.parse(candidate + 'T00:00:00Z');
    if (!Number.isFinite(parsed)) return '';
    return new Date(parsed).toISOString().slice(0, 10) === candidate ? candidate : '';
  }

  function boundary_(value, fieldName) {
    if (isBlank_(value)) return '';
    var candidate = dateKey_(value);
    if (!candidate) {
      throw new Error(fieldName + ' deve usar uma data válida no formato YYYY-MM-DD.');
    }
    return candidate;
  }

  function isTrue_(value) {
    return value === true || String(value || '').toLowerCase() === 'true';
  }

  function calculateMetrics(orders, items, windowStart, windowEnd) {
    if (!Array.isArray(orders) || !Array.isArray(items)) {
      throw new Error('Pedidos e itens devem ser listas para calcular os KPIs.');
    }
    var start = boundary_(windowStart, 'windowStart');
    var end = boundary_(windowEnd, 'windowEnd');
    if (start && end && start > end) {
      throw new Error('windowStart não pode ser posterior a windowEnd.');
    }

    var validOrderIds = {};
    orders.forEach(function (order) {
      var orderId = String(order && order.order_id || '').trim();
      var orderDate = dateKey_(order && order.order_date);
      if (!orderId || !isTrue_(order && order.is_valid_sale)) return;
      if (start && (!orderDate || orderDate < start)) return;
      if (end && (!orderDate || orderDate > end)) return;
      validOrderIds[orderId] = true;
    });

    var quantity = 0;
    var revenue = 0;
    var includedItems = 0;
    items.forEach(function (item) {
      var orderId = String(item && item.order_id || '').trim();
      if (!validOrderIds[orderId]) return;
      var itemQuantity = finiteNumber_(item && item.quantity, 'quantity', false);
      quantity += itemQuantity;
      revenue += calculateItemRevenue(
        itemQuantity,
        item && item.unit_value,
        item && item.discount
      );
      includedItems += 1;
    });

    var validOrders = Object.keys(validOrderIds).length;
    if (!Number.isFinite(quantity) || !Number.isFinite(revenue)) {
      throw new Error('Os KPIs calculados excedem o intervalo numérico suportado.');
    }
    var roundedRevenue = roundCurrency_(revenue);
    return {
      validOrders: validOrders,
      includedItems: includedItems,
      itemsQuantity: round_(quantity, QUANTITY_SCALE),
      revenue: roundedRevenue,
      averageTicket: validOrders > 0
        ? roundCurrency_(roundedRevenue / validOrders)
        : 0
    };
  }

  return Object.freeze({
    calculateItemRevenue: calculateItemRevenue,
    calculateMetrics: calculateMetrics
  });
})();
