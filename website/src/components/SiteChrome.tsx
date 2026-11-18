import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { CONSOLE_URL, NAV, WECOM_CONTACT_URL } from '../site';
import { Icon } from './Icons';

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" to="/" aria-label="知伴健康，回到首页">
          <img src="/assets/brand/zhiban-logo.png" alt="知伴健康 Agent" />
        </Link>

        <nav className="site-nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `site-nav__link${isActive ? ' is-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="site-header__actions">
          <a className="site-header__console" href={CONSOLE_URL}>
            登录控制台
          </a>
          <a
            className="btn btn--primary btn--small"
            href={WECOM_CONTACT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            预约演示
            <Icon name="arrow" size={14} />
          </a>
          <button
            ref={buttonRef}
            type="button"
            className="menu-btn"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? '关闭菜单' : '菜单'}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? 'close' : 'menu'} size={18} />
            <span>菜单</span>
          </button>
        </div>
      </div>

      {open ? (
        <div className="mobile-menu" id="mobile-menu" ref={menuRef}>
          <nav aria-label="移动端导航">
            {NAV.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `mobile-menu__link${isActive ? ' is-active' : ''}`}
              >
                {item.label}
                <Icon name="arrow" size={15} />
              </NavLink>
            ))}
            <a className="mobile-menu__console" href={CONSOLE_URL}>
              登录控制台
              <Icon name="arrow" size={15} />
            </a>
            <a
              className="mobile-menu__cta btn btn--primary"
              href={WECOM_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              预约演示
              <Icon name="arrow" size={15} />
            </a>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <Link className="brand" to="/" aria-label="知伴健康，回到首页">
          <img src="/assets/brand/zhiban-logo-white.png" alt="知伴健康 Agent" />
        </Link>
        <nav className="site-footer__nav" aria-label="页脚导航">
          <Link to="/">首页</Link>
          {NAV.map((item) => (
            <Link key={item.path} to={item.path}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="site-footer__actions">
          <a className="site-footer__console" href={CONSOLE_URL}>登录控制台</a>
          <a
            className="btn btn--primary btn--small"
            href={WECOM_CONTACT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            预约演示
            <Icon name="arrow" size={14} />
          </a>
        </div>
      </div>
      <p className="site-footer__tagline">知伴健康 · 为健康服务机构提供客户跟进与团队协作工具</p>
    </footer>
  );
}
