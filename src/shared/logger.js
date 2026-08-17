let debugEnabled = false;

export function setDebugLogging(enabled) {
  debugEnabled = Boolean(enabled);
}

export function debug(...args) {
  if (debugEnabled) console.debug('[Media Scout]', ...args);
}

export function warn(...args) {
  console.warn('[Media Scout]', ...args);
}
