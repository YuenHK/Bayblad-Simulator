import "./projectResources.css";

const RESOURCES = [
  { title: "了解這個專案", detail: "開源程式與專案介紹", href: "https://github.com/YuenHK/Bayblad-Simulator#readme", icon: "code" },
  { title: "ShapeCut", detail: "我的另一個作品 · 雷射切割工具", href: "https://yuenhk.github.io/ShapeCut/", icon: "layers" },
  { title: "教師後台", detail: "對戰紀錄、設計與使用統計", href: "https://bayblad-simulator-api.onrender.com/admin/", icon: "grid" },
] as const;

export function ProjectResources() {
  return <footer className="project-resources designer-shell" aria-label="專案與更多作品">
    <div className="resource-brand"><span>ARENA LAB</span><small>專案與工具</small></div>
    <div className="resource-links">{RESOURCES.map(({ title, detail, href, icon }) => <a key={href} href={href} target="_blank" rel="noopener noreferrer" aria-label={title} aria-describedby="resource-window-note">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
        {icon === "code" ? <path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-16-2 18" /> : icon === "layers" ? <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /> : <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />}
      </svg>
      <span><strong>{title} <span aria-hidden="true">↗</span></strong><small>{detail}</small></span>
    </a>)}</div>
    <small id="resource-window-note" className="resource-window-note">連結會在新分頁開啟，保留你目前的設計與連線。</small>
  </footer>;
}
