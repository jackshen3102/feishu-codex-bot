let config;
let initialization;
let identity = { enabled: false, user: null, canManage: true };
export const currentSession = () => ({ ...identity });
export const agentSettingsAvailable = () => !!config?.agentSettingsAvailable;

export function initializeSession() {
  initialization ||= (async () => {
    const response = await fetch('/api/oncall/auth-config', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('暂时无法读取访问配置');
    config = await response.json();
    if (config.enabled) throw new Error('请使用已配置的登录入口');
    const me = await fetch('/api/oncall/me', { cache: 'no-store', credentials: 'same-origin' });
    if (!me.ok) throw new Error('暂时无法读取访问权限');
    identity = await me.json();
    return currentSession();
  })().catch(error => { initialization = null; throw error; });
  return initialization;
}

export async function authorizedFetch(input, options = {}) {
  if (new URL(input, location.href).origin !== location.origin) throw new Error('不允许访问其他站点');
  await initializeSession();
  return fetch(input, { ...options, credentials: 'same-origin', cache: 'no-store' });
}
export function signIn() { initialization = null; return initializeSession(); }
export function signOut() { return Promise.resolve(); }
