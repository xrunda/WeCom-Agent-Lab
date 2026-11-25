/**
 * 内联 SVG 图标（设计稿 H03–H10 用的线性图标）。
 *
 * 之前用 CSS 拼的相机/碗形状太粗糙，底栏甚至用了「历 / 养 / 我」文字占位，
 * 与设计稿差距明显。这里统一为 stroke 线性图标，颜色跟随 currentColor。
 */
export type IconName =
  | 'home'
  | 'calendar'
  | 'bowl'
  | 'user'
  | 'camera'
  | 'chat'
  | 'team'
  | 'bell'
  | 'shield'
  | 'doc'
  | 'chart'
  | 'chevron'
  | 'leaf'
  | 'cup'
  | 'clock';

const PATHS: Record<IconName, string> = {
  home: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z',
  calendar: 'M4 7h16v12H4zM8 4v4M16 4v4M4 11h16',
  bowl: 'M4 12h16a8 8 0 0 1-16 0zM9 8c0-1.5 1-2 1-3M13 8c0-1.5 1-2 1-3',
  user: 'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c0-3.3 3.1-5 7-5s7 1.7 7 5',
  camera:
    'M4 8.5h3l1.4-2h7.2L17 8.5h3v11H4zM12 17a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z',
  chat: 'M4 6.5h16v9H9l-5 3.5zM8 11h8',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 19c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5M16 6.2a2.6 2.6 0 0 1 0 5M18 14.8c2 .6 3 2 3 4.2',
  bell: 'M12 4a5 5 0 0 1 5 5v4l2 3H5l2-3V9a5 5 0 0 1 5-5zM10 19a2 2 0 0 0 4 0',
  shield: 'M12 3.5 19 6v6c0 4-3 6.8-7 8.5-4-1.7-7-4.5-7-8.5V6zM9.5 12l2 2 3.5-3.8',
  doc: 'M7 3.5h7l4 4V20H7zM14 3.5V8h4M9.5 12h6M9.5 15.5h6',
  chart: 'M5 19V11M11 19V7M17 19v-5',
  chevron: 'M9 6l6 6-6 6',
  leaf: 'M5 19c0-7 5-12 14-13-1 9-6 13-14 13zM8 16c2-3 5-5 8-6',
  cup: 'M6 8h11v5a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5zM17 9h2.5a2.5 2.5 0 0 1 0 5H17M6 21h12',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.8',
};

export function Icon({
  name,
  size = 22,
  strokeWidth = 1.7,
  className = '',
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
