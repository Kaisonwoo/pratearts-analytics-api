var PRADataLayerSchema = (function () {
  'use strict';

  var DEFINITIONS = [
    ['raw','raw_orders','order_id',['order_id','order_number','store_order_number','order_date','departure_date','expected_date','status_id','store_id','category_id','seller_id','products_total','order_total','other_expenses','freight','discount_value','discount_unit','updated_at','run_id']],
    ['raw','raw_order_items','item_key',['item_key','order_id','item_id','product_id','sku','unit','quantity','unit_value','discount','source_position','updated_at','run_id']],
    ['raw','raw_products','product_id',['product_id','parent_product_id','sku','name','type','status','format','price','cost_price','virtual_stock','is_variation','updated_at','run_id']],
    ['raw','raw_product_suppliers','link_id',['link_id','product_id','supplier_id','description','supplier_sku','cost_price','purchase_price','is_default','updated_at','run_id']],
    ['staging','stg_orders','order_id',['order_id','order_number','order_date','status_id','products_total','order_total','freight','discount_value','is_valid_sale','source_updated_at','processed_at','run_id']],
    ['staging','stg_order_items','item_key',['item_key','order_id','product_id','sku','quantity','unit_value','discount','item_revenue','source_updated_at','processed_at','run_id']],
    ['staging','stg_products','product_id',['product_id','parent_product_id','analysis_product_id','sku','name','is_variation','source_updated_at','processed_at','run_id']],
    ['staging','stg_product_suppliers','product_id',['product_id','supplier_count','link_state','supplier_id','supplier_link_id','supplier_rule','source_updated_at','processed_at','run_id']],
    ['mart','mart_kpis','period_key',['period_key','period_start','period_end','valid_orders','items_quantity','revenue','average_ticket','calculated_at','run_id']],
    ['mart','mart_product_sales','mart_key',['mart_key','period_key','product_id','parent_product_id','sku','supplier_id','quantity','revenue','orders_count','calculated_at','run_id']],
    ['logs','sync_runs','run_id',['run_id','job_name','status','started_at','finished_at','duration_ms','pages_processed','records_processed','error_code','correlation_id']],
    ['logs','data_quality_errors','error_key',['error_key','entity_type','entity_key','error_code','severity','detected_at','resolved_at','run_id']],
    ['logs','order_detail_errors','order_id',['order_id','error_code','status_code','correlation_id','attempts','last_attempt_at','run_id','resolved_at']],
    ['logs','recalc_windows','recalc_key',['recalc_key','window_start','window_end','reason','status','marked_at','run_id']]
  ];

  function copy_(item) {
    return { layer: item[0], sheet: item[1], key: item[2], headers: item[3].slice() };
  }

  function list() { return DEFINITIONS.map(copy_); }
  function getBySheet(name) {
    var target = String(name || '');
    for (var i = 0; i < DEFINITIONS.length; i += 1) {
      if (DEFINITIONS[i][1] === target) return copy_(DEFINITIONS[i]);
    }
    return null;
  }

  return Object.freeze({
    VERSION: '2',
    METADATA_SHEET: '_schema_registry',
    METADATA_HEADERS: Object.freeze(['sheet_name','layer','primary_key','column_count','schema_version']),
    list: list,
    getBySheet: getBySheet
  });
})();
