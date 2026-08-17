export async function reconcileSiteAccessGrant(siteAccess, contains) {
  const origin = typeof siteAccess?.origin === 'string' ? siteAccess.origin.trim() : '';
  if (!origin || typeof contains !== 'function') {
    return { checked: false, changed: false, siteAccess: siteAccess || null };
  }

  const granted = Boolean(await contains({ origins: [origin] }));
  return {
    checked: true,
    changed: Boolean(siteAccess?.granted) !== granted,
    siteAccess: { ...siteAccess, origin, granted }
  };
}
