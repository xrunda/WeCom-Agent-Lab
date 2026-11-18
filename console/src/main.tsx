import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import 'antd/dist/reset.css';
import './styles.css';

import App from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { consoleTheme } from './theme/antd-theme.ts';

/** 部署在子路径时（构建用 CONSOLE_BASE=/console/），路由需要同样的 basename。 */
const consoleBasename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={consoleTheme}>
      <AntApp>
        <BrowserRouter basename={consoleBasename}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
