/**
 * SSO module using MSAL.js (Microsoft Authentication Library).
 * Handles interactive login via popup and silent token refresh.
 * Acquires a delegated token for Azure Management API — no client secret needed.
 */

let _msalInstance = null;

/**
 * Initialize (or re-initialize) a PublicClientApplication.
 * Called each time the user clicks "Sign in" in case tenantId/clientId changed.
 */
async function msalInit(tenantId, clientId) {
  const config = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: window.location.origin,   // must be registered as SPA redirect URI
    },
    cache: {
      cacheLocation: 'sessionStorage',       // don't persist across browser tabs
      storeAuthStateInCookie: false,
    },
  };
  _msalInstance = new msal.PublicClientApplication(config);
}

/**
 * Get an access token for Azure Management API.
 * Tries silent renewal first; falls back to interactive popup.
 * Returns the raw access_token string.
 */
async function msalAcquireToken(tenantId, clientId) {
  await msalInit(tenantId, clientId);

  const scopes  = ['https://management.azure.com/user_impersonation'];
  const accounts = _msalInstance.getAllAccounts();

  // Try silent acquisition if we already have an account in cache
  if (accounts.length > 0) {
    try {
      const result = await _msalInstance.acquireTokenSilent({
        scopes,
        account: accounts[0],
      });
      return { token: result.accessToken, account: accounts[0] };
    } catch (_) {
      // Silent failed — fall through to interactive
    }
  }

  // Interactive popup
  const result = await _msalInstance.loginPopup({
    scopes,
    prompt: 'select_account',
  });
  return { token: result.accessToken, account: result.account };
}

/** Sign out the current MSAL account. */
async function msalLogout() {
  if (!_msalInstance) return;
  const accounts = _msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    await _msalInstance.logoutPopup({ account: accounts[0] });
  }
  _msalInstance = null;
}

/** Return display name of the cached account, or null. */
function msalCurrentAccount() {
  if (!_msalInstance) return null;
  const accounts = _msalInstance.getAllAccounts();
  return accounts.length > 0 ? (accounts[0].name || accounts[0].username) : null;
}
