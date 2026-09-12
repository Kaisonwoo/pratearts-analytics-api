var PRARuntimeBudget = (function () {
  'use strict';

  var DEFAULT_BUDGET_MS = 270000;
  var DEFAULT_RESERVE_MS = 15000;
  var MAX_BUDGET_MS = 330000;

  function finiteInteger_(value, fallback) {
    var candidate = Number(value);
    return Number.isInteger(candidate) ? candidate : fallback;
  }

  function create(options) {
    options = options || {};
    var startedAtMs = Date.now();
    var budgetMs = finiteInteger_(options.budgetMs, DEFAULT_BUDGET_MS);
    var reserveMs = finiteInteger_(options.reserveMs, DEFAULT_RESERVE_MS);
    var explicitDeadline = Number(options.deadlineAtMs);

    if (budgetMs < 1000 || budgetMs > MAX_BUDGET_MS) {
      throw new Error('O orcamento de execucao deve estar entre 1000 e 330000 ms.');
    }
    if (reserveMs < 0 || reserveMs >= budgetMs) {
      throw new Error('A reserva de execucao deve ser menor que o orcamento total.');
    }

    var deadlineAtMs = Number.isFinite(explicitDeadline) && explicitDeadline > 0
      ? explicitDeadline
      : startedAtMs + budgetMs;

    function remainingMs() {
      return Math.max(0, deadlineAtMs - Date.now());
    }

    function shouldYield() {
      return remainingMs() <= reserveMs;
    }

    return Object.freeze({
      budgetMs: budgetMs,
      deadlineAtMs: deadlineAtMs,
      reserveMs: reserveMs,
      remainingMs: remainingMs,
      shouldYield: shouldYield
    });
  }

  return Object.freeze({ create: create });
})();
