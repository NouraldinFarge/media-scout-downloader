import { redactReportValue } from './report-privacy.js';

let debugEnabled = false;

export function setDebugLogging(enabled) {
  debugEnabled = Boolean(enabled);
}

export function debug(...args) {
  if (debugEnabled) console.debug('[Media Scout]', ...args.map(sanitizeLogValue));
}

export function warn(...args) {
  console.warn('[Media Scout]', ...args.map(sanitizeLogValue));
}

export function sanitizeLogValue(value) {
  if (value instanceof Error) {
    return {
      name: String(value.name || 'Error').slice(0, 80),
      message: redactReportValue(String(value.message || ''), 'message')
    };
  }
  return redactReportValue(value, 'log');
}
