import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  getSession,
  getTenant,
  login as loginRequest,
  logout as logoutRequest,
  updateTenant as updateTenantRequest,
  type TenantPatch,
} from '../mock/api.ts';
import type { Session, Tenant, TenantSettings } from '../types.ts';

interface AuthContextValue {
  session: Session | null;
  tenant: Tenant | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<Session>;
  signOut: () => Promise<void>;
  refreshTenant: () => Promise<void>;
  updateTenant: (patch: TenantPatch) => Promise<Tenant>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((next) => {
        if (cancelled) return;
        setSession(next);
        setTenant(next?.tenant ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSession(null);
        setTenant(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const next = await loginRequest(username, password);
    setSession(next);
    setTenant(next.tenant);
    return next;
  }, []);

  const signOut = useCallback(async () => {
    await logoutRequest();
    setSession(null);
    setTenant(null);
  }, []);

  const refreshTenant = useCallback(async () => {
    const next = await getTenant();
    setTenant(next);
    setSession((current) => (current ? { ...current, tenant: next } : current));
  }, []);

  const updateTenant = useCallback(async (patch: TenantPatch) => {
    const next = await updateTenantRequest(patch);
    setTenant(next);
    setSession((current) => (current ? { ...current, tenant: next } : current));
    return next;
  }, []);

  const can = useCallback(
    // permissions 可能缺失（例如登录接口只返回 account/tenant），缺失时按无权限处理
    (permission: string) => sessionCan(session, permission),
    [session],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ session, tenant, loading, signIn, signOut, refreshTenant, updateTenant, can }),
    [session, tenant, loading, signIn, signOut, refreshTenant, updateTenant, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}

/** 权限判断收敛为纯函数：会话或 permissions 缺失时安全返回 false。 */
export function sessionCan(session: Session | null, permission: string): boolean {
  return Boolean(session?.permissions?.includes(permission));
}

/** 全局称谓：页面里不要写死「患者」，用这个 hook */
export function useTerm(): string {
  const { tenant } = useAuth();
  return tenant?.patientTerm ?? '患者';
}

export function useTenantSettings(): TenantSettings | undefined {
  const { tenant } = useAuth();
  return tenant?.settings;
}
