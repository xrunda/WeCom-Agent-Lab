import { useRef, useState } from 'react';

import { Icon } from './Icons';

interface ProductVideoProps {
  src: string;
  poster: string;
  subtitles: string;
  title: string;
  /** hero：首屏用浅色封面，不在浅色海报上压深色蒙层。 */
  variant?: 'hero';
}

export function ProductVideo({ src, poster, subtitles, title, variant }: ProductVideoProps) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const start = () => {
    setPlaying(true);
    const video = videoRef.current;
    if (video) {
      video.controls = true;
      void video.play();
    }
  };

  return (
    <div className={`video-frame${variant ? ` video-frame--${variant}` : ''}`}>
      <video
        ref={videoRef}
        className="video-frame__video"
        poster={poster}
        preload="none"
        playsInline
        controls={playing}
        aria-label={title}
      >
        <source src={src} type="video/mp4" />
        <track kind="subtitles" src={subtitles} srcLang="zh" label="中文（视频已内嵌字幕，可选）" />
        您的浏览器不支持视频播放。
      </video>
      {!playing ? (
        <button type="button" className="video-frame__cover" onClick={start} aria-label={`播放产品演示：${title}`}>
          <span className="video-frame__play">
            <Icon name="play" size={26} />
          </span>
          <span className="video-frame__label">播放产品演示</span>
          <span className="video-frame__note">约 2 分钟 · 中文字幕</span>
        </button>
      ) : null}
    </div>
  );
}
