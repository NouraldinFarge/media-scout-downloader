import { ERROR_CATEGORIES } from '../shared/constants.js';
import { getDiagnostics, saveDiagnostics, resetDiagnostics as resetDiagnosticsStorage } from '../shared/storage-utils.js';
import { nowISO } from '../shared/utils.js';

export class DiagnosticsManager {
  constructor() {
    this.state = emptyDiagnosticsState();
  }

  async load() {
    try {
      this.state = normalizeDiagnosticsState(await getDiagnostics());
    } catch (_error) {
      // Learning data is optional and must never prevent the download service
      // from starting when local storage is temporarily unavailable.
      this.state = emptyDiagnosticsState();
    }
    return this.state;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async recordStrategySuccess(strategyName) {
    try {
      const entry = this._entry(strategyName);
      entry.success += 1;
      entry.lastSuccessAt = nowISO();
      this.state.updatedAt = nowISO();
      await saveDiagnostics(this.state);
    } catch (_error) {
      // Strategy learning is best-effort and must never change a download result.
    }
  }

  async recordStrategyFailure(strategyName, category = ERROR_CATEGORIES.UNKNOWN) {
    try {
      const entry = this._entry(strategyName);
      entry.failure += 1;
      entry.lastFailureAt = nowISO();
      const errorCategory = safeKey(category, ERROR_CATEGORIES.UNKNOWN);
      this.state.errors[errorCategory] = safeCount(this.state.errors[errorCategory]) + 1;
      this.state.updatedAt = nowISO();
      await saveDiagnostics(this.state);
    } catch (_error) {
      // Strategy learning is best-effort and must never change retry behavior.
    }
  }

  prioritize(strategyNames) {
    return [...strategyNames].sort((a, b) => this._score(b) - this._score(a));
  }

  async reset() {
    this.state = normalizeDiagnosticsState(await resetDiagnosticsStorage());
    return this.snapshot();
  }

  _entry(strategyName) {
    this.state = normalizeDiagnosticsState(this.state);
    const name = safeKey(strategyName, 'unknown-strategy');
    if (!this.state.strategies[name]) {
      this.state.strategies[name] = { success: 0, failure: 0, lastSuccessAt: null, lastFailureAt: null };
    }
    return this.state.strategies[name];
  }

  _score(strategyName) {
    const entry = this.state?.strategies?.[strategyName] || { success: 0, failure: 0 };
    // Small, local-only learning loop: strategies that have worked on this browser get tried first.
    return (safeCount(entry.success) * 2) - safeCount(entry.failure);
  }
}

function emptyDiagnosticsState() {
  return { strategies: Object.create(null), errors: Object.create(null), updatedAt: null };
}

function normalizeDiagnosticsState(value = {}) {
  const normalized = emptyDiagnosticsState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  if (value.strategies && typeof value.strategies === 'object' && !Array.isArray(value.strategies)) {
    for (const [rawName, rawEntry] of Object.entries(value.strategies).slice(0, 64)) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const name = safeKey(rawName);
      if (!name) continue;
      normalized.strategies[name] = {
        success: safeCount(rawEntry.success),
        failure: safeCount(rawEntry.failure),
        lastSuccessAt: safeTimestamp(rawEntry.lastSuccessAt),
        lastFailureAt: safeTimestamp(rawEntry.lastFailureAt)
      };
    }
  }
  if (value.errors && typeof value.errors === 'object' && !Array.isArray(value.errors)) {
    for (const [rawName, rawCount] of Object.entries(value.errors).slice(0, 64)) {
      const name = safeKey(rawName);
      if (name) normalized.errors[name] = safeCount(rawCount);
    }
  }
  normalized.updatedAt = safeTimestamp(value.updatedAt);
  return normalized;
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(1_000_000_000, Math.floor(number)) : 0;
}

function safeKey(value, fallback = '') {
  const normalized = String(value || fallback).replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, 80);
  if (!/^(?:__proto__|prototype|constructor)$/i.test(normalized)) return normalized;
  const safeFallback = String(fallback || '').replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, 80);
  return /^(?:__proto__|prototype|constructor)$/i.test(safeFallback) ? '' : safeFallback;
}

function safeTimestamp(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 40) : null;
}
