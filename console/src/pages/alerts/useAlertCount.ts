import { useEffect, useState } from 'react';

import { subscribeAlerts, unresolvedCount } from '../../mock/alerts.ts';

/** 菜单角标：打开页面时校准一次，之后由 SSE / 本地告警事件增量刷新 */
export function useAlertCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      unresolvedCount()
        .then((value) => {
          if (active) setCount(value.total);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeAlerts(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return count;
}
