import type { SVGProps } from 'react';

type IconName =
  | 'arrow'
  | 'chat'
  | 'book'
  | 'calendar'
  | 'shield'
  | 'check'
  | 'search'
  | 'users'
  | 'chart'
  | 'bell'
  | 'send'
  | 'spark'
  | 'lock'
  | 'key'
  | 'play'
  | 'close'
  | 'menu'
  | 'camera'
  | 'image'
  | 'clock'
  | 'file'
  | 'pill'
  | 'home';

const PATHS: Record<IconName, JSX.Element> = {
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 3v-4.3A8.5 8.5 0 1 1 21 11.5Z" />
      <path d="M8 11h.01M12 11h.01M16 11h.01" />
    </>
  ),
  book: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3 19c1-3.2 3-5 6-5s5 1.8 6 5" />
      <path d="M16 6.5a3 3 0 0 1 0 5M18 19c.4-1.8 1.2-3.3 2.4-4.4" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M2 20h20" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  send: (
    <>
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12 20 3M17 6l3 3M14 9l3 3" />
    </>
  ),
  play: <path d="M8 5.5 19 12 8 18.5v-13Z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4V8Z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m5 18 5-5 3 3 3-3 4 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  pill: (
    <>
      <path d="M8.5 4.5a4.5 4.5 0 0 1 6.4 6.4l-6.1 6.1a4.5 4.5 0 0 1-6.4-6.4l6.1-6.1Z" />
      <path d="m8 8 6.5 6.5" />
    </>
  ),
  home: <path d="m3 11 9-8 9 8M5 10v10h14V10" />,
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
