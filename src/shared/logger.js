let debugEnabled = false;

export function setDebugLogging(enabled) {
  debugEnabled = Boolean(enabled);
}

export function debug(...args) {
  if (debugEnabled) console.debug('[Media Scout]', ...args);
}

export function info(...args) {
  console.info('[Media Scout]', ...args);
}

export function warn(...args) {
  console.warn('[Media Scout]', ...args);
}

export function error(...args) {
  console.error('[Media Scout]', ...args);
}

export function redactUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}${url.pathname ? '/…' : ''}`;
  } catch (_error) {
    return '[invalid-url]';
  }
}
