import { ERROR_CATEGORIES } from '../shared/constants.js';
import { getDiagnostics, saveDiagnostics, resetDiagnostics as resetDiagnosticsStorage } from '../shared/storage-utils.js';
import { nowISO } from '../shared/utils.js';

export class DiagnosticsManager {
  constructor() {
    this.state = { strategies: {}, errors: {}, updatedAt: null };
  }

  async load() {
    this.state = await getDiagnostics();
    return this.state;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async recordStrategySuccess(strategyName) {
    const entry = this._entry(strategyName);
    entry.success += 1;
    entry.lastSuccessAt = nowISO();
    this.state.updatedAt = nowISO();
    await saveDiagnostics(this.state);
  }

  async recordStrategyFailure(strategyName, category = ERROR_CATEGORIES.UNKNOWN) {
    const entry = this._entry(strategyName);
    entry.failure += 1;
    entry.lastFailureAt = nowISO();
    this.state.errors[category] = (this.state.errors[category] || 0) + 1;
    this.state.updatedAt = nowISO();
    await saveDiagnostics(this.state);
  }

  prioritize(strategyNames) {
    return [...strategyNames].sort((a, b) => this._score(b) - this._score(a));
  }

  async reset() {
    this.state = await resetDiagnosticsStorage();
    return this.snapshot();
  }

  _entry(strategyName) {
    if (!this.state.strategies[strategyName]) {
      this.state.strategies[strategyName] = { success: 0, failure: 0, lastSuccessAt: null, lastFailureAt: null };
    }
    return this.state.strategies[strategyName];
  }

  _score(strategyName) {
    const entry = this.state.strategies[strategyName] || { success: 0, failure: 0 };
    // Small, local-only learning loop: strategies that have worked on this browser get tried first.
    return (entry.success * 2) - entry.failure;
  }
}
