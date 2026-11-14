/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 控制台地址；配置后侧边栏才显示「打开控制台详情」 */
  readonly VITE_CONSOLE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
