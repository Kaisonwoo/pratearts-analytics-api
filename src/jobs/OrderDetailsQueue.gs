var PRAOrderDetailsQueue = (function () {
  'use strict';

  var LOCK_TIMEOUT_MS = 30000;
  var INDEX_VERSION = 1;
  var SHARD_PREFIX = 'BLING_ORDER_DETAILS_QUEUE_SHARD_';
  var MAX_PROPERTY_BYTES = 8500;

  function properties_() {
    return PropertiesService.getScriptProperties();
  }

  function withLock_(callback) {
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      return callback(properties_());
    } finally {
      lock.releaseLock();
    }
  }

  function parseJson_(raw, fallback) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function readIndexFrom_(props) {
    var parsed = parseJson_(
      props.getProperty(PRAConfig.KEYS.BLING_ORDER_DETAILS_QUEUE_INDEX),
      null
    );
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.shards)) {
      return {
        version: INDEX_VERSION,
        shards: [],
        enqueuedTotal: 0,
        completedTotal: 0,
        permanentFailureTotal: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    return parsed;
  }

  function readShardFrom_(props, key) {
    var shard = parseJson_(props.getProperty(key), null);
    if (!shard || !Array.isArray(shard.entries)) return null;
    return shard;
  }

  function safeRunId_(value) {
    var candidate = String(value || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 48);
    return candidate || Utilities.getUuid();
  }

  function positiveId_(value) {
    var candidate = String(value || '');
    return /^\d+$/.test(candidate) && Number(candidate) > 0 ? candidate : null;
  }

  function extractIds_(orders) {
    var seen = {};
    return (orders || []).reduce(function (ids, order) {
      var id = order && positiveId_(order.id);
      if (id && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
      return ids;
    }, []);
  }

  function pendingCountFrom_(props, index) {
    return index.shards.reduce(function (total, key) {
      var shard = readShardFrom_(props, key);
      return total + (shard ? shard.entries.length : 0);
    }, 0);
  }

  function summaryFrom_(props, index, added) {
    return {
      ok: true,
      code: 'order_details_enqueued',
      added: Number(added || 0),
      pending: pendingCountFrom_(props, index),
      enqueuedTotal: Number(index.enqueuedTotal || 0),
      completedTotal: Number(index.completedTotal || 0),
      permanentFailureTotal: Number(index.permanentFailureTotal || 0),
      updatedAt: index.updatedAt
    };
  }

  function enqueuePage(orders, page, context) {
    if (!Array.isArray(orders)) {
      throw new Error('A página de pedidos deve ser uma lista.');
    }
    var pageNumber = Number(page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new Error('Número de página inválido para a fila de detalhes.');
    }

    var ids = extractIds_(orders);
    return withLock_(function (props) {
      var index = readIndexFrom_(props);
      var known = {};
      index.shards.forEach(function (key) {
        var existingShard = readShardFrom_(props, key);
        (existingShard ? existingShard.entries : []).forEach(function (entry) {
          known[String(entry.id)] = true;
        });
      });
      var freshIds = ids.filter(function (id) {
        if (known[id]) return false;
        known[id] = true;
        return true;
      });
      if (freshIds.length === 0) {
        index.updatedAt = new Date().toISOString();
        var unchanged = {};
        unchanged[PRAConfig.KEYS.BLING_ORDER_DETAILS_QUEUE_INDEX] = JSON.stringify(index);
        props.setProperties(unchanged, false);
        return summaryFrom_(props, index, 0);
      }

      var runId = safeRunId_(context && context.runId);
      var shardKey = SHARD_PREFIX + runId + '_' + pageNumber;
      var shard = {
        version: INDEX_VERSION,
        runId: runId,
        page: pageNumber,
        entries: freshIds.map(function (id) { return { id: id, attempts: 0 }; }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      var serializedShard = JSON.stringify(shard);
      if (serializedShard.length > MAX_PROPERTY_BYTES) {
        throw new Error('A página excede o limite seguro da fila de detalhes.');
      }
      if (index.shards.indexOf(shardKey) < 0) index.shards.push(shardKey);
      index.enqueuedTotal = Number(index.enqueuedTotal || 0) + freshIds.length;
      index.updatedAt = new Date().toISOString();

      var values = {};
      values[shardKey] = serializedShard;
      values[PRAConfig.KEYS.BLING_ORDER_DETAILS_QUEUE_INDEX] = JSON.stringify(index);
      props.setProperties(values, false);
      return summaryFrom_(props, index, freshIds.length);
    });
  }

  function peek(maxOrders) {
    var limit = Number(maxOrders);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('O lote de detalhes deve estar entre 1 e 100 pedidos.');
    }
    var props = properties_();
    var index = readIndexFrom_(props);
    var candidates = [];
    index.shards.forEach(function (key, shardPosition) {
      var shard = readShardFrom_(props, key);
      (shard ? shard.entries : []).forEach(function (entry, entryPosition) {
        var id = positiveId_(entry.id);
        if (id) {
          candidates.push({
            id: id,
            attempts: Number(entry.attempts || 0),
            shardPosition: shardPosition,
            entryPosition: entryPosition
          });
        }
      });
    });
    candidates.sort(function (left, right) {
      return left.attempts - right.attempts ||
        left.shardPosition - right.shardPosition ||
        left.entryPosition - right.entryPosition;
    });
    return candidates.slice(0, limit).map(function (candidate) {
      return { id: candidate.id, attempts: candidate.attempts };
    });
  }

  function acknowledge(outcomes) {
    var byId = {};
    (outcomes || []).forEach(function (outcome) {
      var id = positiveId_(outcome && outcome.id);
      if (id) byId[id] = outcome;
    });

    return withLock_(function (props) {
      var index = readIndexFrom_(props);
      var activeShards = [];
      var completed = 0;
      var permanentFailures = 0;
      index.shards.forEach(function (key) {
        var shard = readShardFrom_(props, key);
        if (!shard) return;
        var remaining = [];
        shard.entries.forEach(function (entry) {
          var outcome = byId[String(entry.id)];
          if (!outcome) {
            remaining.push(entry);
          } else if (outcome.status === 'success') {
            completed += 1;
          } else if (outcome.status === 'permanent_failure') {
            permanentFailures += 1;
          } else {
            entry.attempts = Number(entry.attempts || 0) + 1;
            remaining.push(entry);
          }
        });
        if (remaining.length > 0) {
          shard.entries = remaining;
          shard.updatedAt = new Date().toISOString();
          props.setProperty(key, JSON.stringify(shard));
          activeShards.push(key);
        } else {
          props.deleteProperty(key);
        }
      });
      index.shards = activeShards;
      index.completedTotal = Number(index.completedTotal || 0) + completed;
      index.permanentFailureTotal = Number(index.permanentFailureTotal || 0) + permanentFailures;
      index.updatedAt = new Date().toISOString();
      var values = {};
      values[PRAConfig.KEYS.BLING_ORDER_DETAILS_QUEUE_INDEX] = JSON.stringify(index);
      props.setProperties(values, false);
      return summaryFrom_(props, index, 0);
    });
  }

  function getSummary() {
    var props = properties_();
    var index = readIndexFrom_(props);
    return summaryFrom_(props, index, 0);
  }

  return Object.freeze({
    enqueuePage: enqueuePage,
    peek: peek,
    acknowledge: acknowledge,
    getSummary: getSummary
  });
})();
