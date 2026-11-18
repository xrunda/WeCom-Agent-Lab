import { Link } from 'react-router-dom';

import { Icon } from './Icons';

interface VideoTeaserProps {
  poster: string;
  to: string;
}

/** 首页只展示封面与播放入口；实际播放在业务场景页完成（issue #217）。 */
export function VideoTeaser({ poster, to }: VideoTeaserProps) {
  return (
    <div className="video-frame video-frame--teaser">
      <img className="video-frame__poster" src={poster} alt="知伴健康产品演示封面" loading="lazy" />
      <Link className="video-frame__cover" to={to} aria-label="播放产品演示，前往业务场景页">
        <span className="video-frame__play">
          <Icon name="play" size={26} />
        </span>
        <span className="video-frame__label">播放产品演示</span>
        <span className="video-frame__note">约 2 分钟 · 中文字幕</span>
      </Link>
    </div>
  );
}
