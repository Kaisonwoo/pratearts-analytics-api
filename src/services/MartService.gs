var PRAMartService = (function () {
  'use strict';

  function text(value) { return value == null ? '' : String(value).trim(); }
  function fail(code) {
    var error = new Error('Construção de marts bloqueada: ' + code + '.');
    error.code = code;
    throw error;
  }
  function date(value) {
    var candidate = Object.prototype.toString.call(value) === '[object Date]'
      ? (isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10))
      : text(value).slice(0, 10);
    var parsed = Date.parse(candidate + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || !Number.isFinite(parsed) ||
        new Date(parsed).toISOString().slice(0, 10) !== candidate) fail('mart_invalid_date');
    return candidate;
  }
  function number(value) {
    if (text(value) === '' || !Number.isFinite(Number(value))) fail('mart_invalid_number');
    return Number(value);
  }
  function boolean(value) {
    var candidate = text(value).toLowerCase();
    if (candidate !== 'true' && candidate !== 'false') fail('mart_unclassified_order');
    return candidate === 'true';
  }
  function index(rows, field) {
    var result = Object.create(null);
    rows.forEach(function (row) {
      var key = text(row[field]);
      if (!key || result[key]) fail('mart_duplicate_or_missing_key');
      result[key] = row;
    });
    return result;
  }
  function sorted(rows) {
    return rows.slice().sort(function (a, b) {
      var x = JSON.stringify(a); var y = JSON.stringify(b);
      return x < y ? -1 : (x > y ? 1 : 0);
    });
  }
  function hash(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(value), Utilities.Charset.UTF_8).map(function (byte) {
      return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
    }).join('');
  }
  function timestamp(value) {
    var parsed = Object.prototype.toString.call(value) === '[object Date]' ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(parsed)) fail('mart_staging_outdated');
    return new Date(parsed).toISOString();
  }

  // Validate raw/staging coherence before any destination is changed.
  function prepare(data, attendedId) {
    var rawOrders = index(data.raw_orders, 'order_id');
    var rawItems = index(data.raw_order_items, 'item_key');
    var orders = index(data.stg_orders, 'order_id');
    var items = index(data.stg_order_items, 'item_key');
    var products = index(data.raw_products, 'product_id');
    var suppliers = index(data.stg_product_suppliers, 'product_id');
    if (Object.keys(rawOrders).length !== Object.keys(orders).length ||
        Object.keys(rawItems).length !== Object.keys(items).length) fail('mart_staging_outdated');
    var days = Object.create(null);
    Object.keys(orders).sort().forEach(function (id) {
      var order = orders[id]; var raw = rawOrders[id];
      var day = date(order.order_date);
      var valid = boolean(order.is_valid_sale);
      if (!raw || date(raw.order_date) !== day || text(raw.status_id) !== text(order.status_id) ||
          timestamp(raw.updated_at) !== timestamp(order.source_updated_at) ||
          valid !== (text(order.status_id) === attendedId)) fail('mart_staging_outdated');
      if (!days[day]) days[day] = { orders: [], items: [], signature: [] };
      days[day].orders.push({ order_id: id, order_date: day, is_valid_sale: valid });
      days[day].signature.push(['order', id, valid]);
    });
    Object.keys(items).sort().forEach(function (key) {
      var item = items[key]; var raw = rawItems[key];
      var order = orders[text(item.order_id)];
      if (!order || !raw) fail('mart_staging_outdated');
      if (timestamp(raw.updated_at) !== timestamp(item.source_updated_at) ||
          ['order_id', 'product_id', 'sku'].some(function (field) {
            return text(raw[field]) !== text(item[field]);
          }) || ['quantity', 'unit_value', 'discount'].some(function (field) {
            return Number(raw[field]) !== Number(item[field]);
          }) || text(raw.quantity) === '' || text(raw.unit_value) === '') fail('mart_staging_outdated');
      var revenue;
      try { revenue = PRAKpiService.calculateItemRevenue(item.quantity, item.unit_value, item.discount); }
      catch (error) { fail('mart_invalid_revenue'); }
      if (number(item.item_revenue) !== revenue) fail('mart_invalid_revenue');
      var productId = text(item.product_id);
      var product = products[productId];
      var parentId = product ? text(product.parent_product_id) : '';
      if (productId && parentId === productId) fail('mart_invalid_product_parent');
      if (parentId && products[parentId] && text(products[parentId].parent_product_id)) {
        fail('mart_invalid_product_parent');
      }
      var supplier = suppliers[productId];
      var supplierId = supplier ? text(supplier.supplier_id) : '';
      var linkState = supplier ? text(supplier.link_state) : 'none';
      if (['none', 'single', 'multiple'].indexOf(linkState) < 0 ||
          (linkState === 'none' && supplierId) ||
          (linkState !== 'none' && (!/^\d+$/.test(supplierId) || Number(supplierId) < 1))) {
        fail('mart_invalid_supplier_state');
      }
      var enriched = {
        item_key: key, order_id: text(item.order_id), product_id: productId,
        parent_product_id: parentId, sku: text(item.sku), supplier_id: supplierId,
        quantity: number(item.quantity), unit_value: number(item.unit_value),
        discount: Number(item.discount || 0), item_revenue: revenue,
        link_state: linkState, is_valid_sale: boolean(order.is_valid_sale)
      };
      var day = days[date(order.order_date)];
      day.items.push(enriched);
      day.signature.push(['item', key, enriched.order_id, productId, parentId,
        enriched.sku, supplierId, enriched.quantity, enriched.unit_value,
        enriched.discount, revenue, linkState]);
    });
    var stagedProducts = Object.keys(products).sort().map(function (id) {
      var product = products[id]; var parent = text(product.parent_product_id);
      if (parent === id || (parent && products[parent] && text(products[parent].parent_product_id))) {
        fail('mart_invalid_product_parent');
      }
      return [id, parent, parent || id, text(product.sku), text(product.name),
        Boolean(parent), timestamp(product.updated_at)];
    });
    return { days: days, products: stagedProducts };
  }

  function buildDay(dayKey, source, calculatedAt, runId) {
    source = source || { orders: [], items: [] };
    var metrics = PRAKpiService.calculateMetrics(source.orders, source.items, dayKey, dayKey);
    var groups = Object.create(null);
    source.items.forEach(function (item) {
      if (!item.is_valid_sale) return;
      var productId = item.product_id;
      // Missing products remain distinct by SKU (or item key), never silently disappear.
      var identity = productId || ('unknown-' + (item.sku || item.item_key));
      var family = item.parent_product_id || identity;
      [['product', identity, productId, item.parent_product_id, item.sku],
        ['parent', family, item.parent_product_id || productId, '', '']].forEach(function (level) {
        var key = level[0] + ':' + dayKey + ':' + encodeURIComponent(level[1]) + ':' +
          encodeURIComponent(level[4]) + ':' + encodeURIComponent(item.supplier_id);
        if (!groups[key]) groups[key] = { row: [key, dayKey, level[2], level[3], level[4],
          item.supplier_id, 0, 0, 0, calculatedAt, runId], ids: Object.create(null) };
        var group = groups[key];
        group.row[6] += item.quantity;
        group.row[7] += Math.round(item.item_revenue * 100);
        group.ids[item.order_id] = true;
      });
    });
    var sales = Object.keys(groups).sort().map(function (key) {
      var group = groups[key];
      group.row[6] = Math.round(group.row[6] * 1000000) / 1000000;
      group.row[7] /= 100;
      group.row[8] = Object.keys(group.ids).length;
      if (!Number.isFinite(group.row[6]) || !Number.isSafeInteger(Math.round(group.row[7] * 100))) {
        fail('mart_numeric_overflow');
      }
      return group.row;
    });
    return {
      kpis: [[dayKey, dayKey, dayKey, metrics.validOrders, metrics.itemsQuantity,
        metrics.revenue, metrics.averageTicket, calculatedAt, runId]],
      sales: sales,
      missingSupplierItems: source.items.filter(function (item) { return item.is_valid_sale && item.link_state === 'none'; }).length,
      multipleSupplierItems: source.items.filter(function (item) { return item.is_valid_sale && item.link_state === 'multiple'; }).length
    };
  }

  function outputHash(kpis, sales) {
    return hash([sorted(kpis.map(function (row) { return row.slice(0, 7); })),
      sorted(sales.map(function (row) { return row.slice(0, 9); }))]);
  }
  return Object.freeze({ prepare: prepare, buildDay: buildDay, hash: hash,
    outputHash: outputHash, date: date, text: text, fail: fail, sorted: sorted });
})();
