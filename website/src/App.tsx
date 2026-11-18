import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';

import { SiteFooter, SiteHeader } from './components/SiteChrome';
import { AdvisorPage } from './pages/AdvisorPage';
import { CustomerAgentPage } from './pages/CustomerAgentPage';
import { WecomRedirectPage } from './pages/WecomRedirectPage';
import { HomePage } from './pages/HomePage';
import { ManagementPage } from './pages/ManagementPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ScenariosPage } from './pages/ScenariosPage';

function ScrollToAnchor() {
  const location = useLocation();
  useEffect(() => {
    const scroll = () => {
      if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
          return;
        }
      }
      window.scrollTo({ top: 0, behavior: 'auto' });
    };

    // 页面截图是懒加载的，图片加载会改变上方高度；在加载完成后再定位一次。
    scroll();
    const timers = [setTimeout(scroll, 120), setTimeout(scroll, 700)];
    window.addEventListener('load', scroll);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener('load', scroll);
    };
  }, [location.pathname, location.hash]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToAnchor />
      <SiteHeader />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/customer-agent" element={<CustomerAgentPage />} />
        <Route path="/advisor" element={<AdvisorPage />} />
        <Route path="/management" element={<ManagementPage />} />
        <Route path="/scenarios" element={<ScenariosPage />} />
        <Route path="/demo" element={<WecomRedirectPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <SiteFooter />
    </BrowserRouter>
  );
}
