/**
 * GoldRush Web — macOS Liquid Glass 主题
 * 视觉参考：macos27.kimi.page / macOS Liquid Glass
 * 浅色磨砂玻璃、系统字体、柔和阴影与弹簧过渡
 */

const SHARED = `
:root {
  --bg-deep: #7eb8c9;
  --bg-mid: #c5dce6;
  --bg-warm: #e8d5b5;
  --glass: rgba(255, 255, 255, 0.72);
  --glass-strong: rgba(255, 255, 255, 0.86);
  --glass-soft: rgba(255, 255, 255, 0.55);
  --glass-inset: rgba(255, 255, 255, 0.45);
  --text: rgba(0, 0, 0, 0.85);
  --text-2: rgba(60, 60, 67, 0.68);
  --text-3: rgba(60, 60, 67, 0.42);
  --hairline: rgba(0, 0, 0, 0.08);
  --hairline-light: rgba(255, 255, 255, 0.55);
  --accent: #007aff;
  --accent-soft: rgba(0, 122, 255, 0.12);
  --gold: #b8860b;
  --gold-soft: rgba(184, 134, 11, 0.14);
  --green: #30d158;
  --green-text: #1a7f37;
  --yellow: #ff9f0a;
  --yellow-text: #9a6700;
  --red: #ff453a;
  --red-text: #c62828;
  --blue-text: #0066cc;
  --radius-lg: 16px;
  --radius-md: 12px;
  --radius-sm: 8px;
  --shadow-window:
    0 0 0 0.5px rgba(0, 0, 0, 0.08),
    0 12px 40px rgba(0, 0, 0, 0.12),
    0 28px 72px rgba(0, 0, 0, 0.08);
  --shadow-card:
    0 4px 16px rgba(0, 0, 0, 0.06),
    0 12px 32px rgba(0, 0, 0, 0.05);
  --shadow-lift:
    0 8px 28px rgba(0, 0, 0, 0.12),
    0 20px 48px rgba(0, 0, 0, 0.08);
  --ease: cubic-bezier(0.25, 0.1, 0.25, 1);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
    "PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif;
  --mono: "SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body {
  margin: 0;
  font-family: var(--font);
  font-size: 14px;
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
  background:
    radial-gradient(ellipse 90% 70% at 15% 10%, rgba(255, 220, 160, 0.45), transparent 55%),
    radial-gradient(ellipse 80% 60% at 85% 20%, rgba(120, 200, 220, 0.5), transparent 50%),
    radial-gradient(ellipse 70% 50% at 50% 90%, rgba(180, 210, 170, 0.35), transparent 55%),
    linear-gradient(165deg, #6fa8bc 0%, #a8c8d4 38%, #d4c4a8 72%, #c9b896 100%);
  background-attachment: fixed;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
button:focus-visible, .sort-btn:focus-visible, .collapse-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* —— 磨砂玻璃材料 —— */
.glass {
  background: var(--glass);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border: 0.5px solid var(--hairline-light);
  box-shadow: var(--shadow-card);
}
.glass-strong {
  background: var(--glass-strong);
  backdrop-filter: blur(48px) saturate(190%);
  -webkit-backdrop-filter: blur(48px) saturate(190%);
  border: 0.5px solid var(--hairline-light);
  box-shadow: var(--shadow-window);
}

/* —— 窗口银边（traffic lights） —— */
.mac-window {
  border-radius: var(--radius-lg);
  overflow: hidden;
  position: relative;
}
.mac-titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
  user-select: none;
}
.traffic {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.traffic span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
  transition: filter 0.15s var(--ease), transform 0.15s var(--ease);
}
.traffic .tl-close { background: #ff5f57; }
.traffic .tl-min { background: #ffbd2e; }
.traffic .tl-max { background: #28c840; }
.mac-window:hover .traffic span { filter: brightness(1.05); }
.mac-titlebar-label {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  letter-spacing: -0.01em;
  margin-right: 52px; /* 平衡左侧 traffic */
}
.mac-titlebar-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

/* —— 共用面板 —— */
.pos-panel, .pred-stats-panel, .rel-panel, .dual-banner, .dq-banner,
.quick-read-card, .pred-hero, .flow-hero, .hero-card, .stat-card,
.report-card, .sc-card, .ps-card, .md-section, .pred-trust,
.pred-action-box, .pred-secondary, .sample-warn, .sidebar-more, .dd-panel {
  transition: transform 0.22s var(--ease), box-shadow 0.22s var(--ease),
    background 0.2s var(--ease), border-color 0.2s var(--ease);
}

.pos-panel, .pred-stats-panel, .rel-panel, .dd-panel, .read-panel, .tr-panel {
  margin: 0 0 14px;
  padding: 18px 20px;
  border-radius: var(--radius-md);
  background: var(--glass);
  backdrop-filter: blur(36px) saturate(170%);
  -webkit-backdrop-filter: blur(36px) saturate(170%);
  border: 0.5px solid var(--hairline);
  box-shadow: var(--shadow-card);
}
.rel-panel { border-left: 3px solid var(--gold); }
.rel-panel.rel-high { border-left-color: var(--green); }
.rel-panel.rel-low { border-left-color: var(--yellow); }
.rel-panel.rel-blocked { border-left-color: var(--red); }

.read-panel { border-left: 3px solid var(--accent); }
.read-title { font-weight: 600; font-size: 0.95rem; color: var(--text); }
.read-sub { font-size: 0.75rem; color: var(--text-3); margin: 4px 0 10px; }
.rc-check-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: flex-start; }
.rc-check-n {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; font-weight: 700; background: var(--accent-soft); color: var(--accent);
}
.rc-check-t { font-size: 0.78rem; font-weight: 600; color: var(--text); }
.rc-check-v { font-size: 0.74rem; color: var(--text-2); line-height: 1.4; margin-top: 2px; }

.tr-panel { border-left: 3px solid #af52de; }
.tr-panel.tr-skip { opacity: 0.92; border-left-color: var(--text-3); }
.tr-title { font-weight: 600; font-size: 0.95rem; color: var(--text); }
.tr-headline { font-size: 0.88rem; font-weight: 600; margin: 6px 0; line-height: 1.4; color: var(--text); }
.tr-hint { font-size: 0.75rem; color: var(--text-3); }

.dd-panel { border-left: 3px solid var(--text-3); }
.dd-panel.dd-skip { border-left-color: var(--text-3); opacity: 0.95; }
.dd-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.dd-title { font-weight: 600; font-size: 0.95rem; color: var(--text); letter-spacing: -0.02em; }
.dd-sub { font-size: 0.72rem; color: var(--text-3); margin-top: 2px; }
.dd-badge {
  margin-left: auto; font-size: 0.72rem; font-weight: 600;
  padding: 4px 10px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline); color: var(--text-2);
}
.dd-badge-move {
  background: rgba(10, 132, 255, 0.1); border-color: rgba(10, 132, 255, 0.25); color: #0a84ff;
}
.dd-headline { font-size: 0.9rem; font-weight: 600; color: var(--text); line-height: 1.4; margin-bottom: 8px; }
.dd-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dd-chip {
  font-size: 0.72rem; font-weight: 600; padding: 4px 10px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline); color: var(--text-2);
}
.dd-chip.dd-up { color: var(--green); background: rgba(52, 199, 89, 0.1); border-color: rgba(52, 199, 89, 0.25); }
.dd-chip.dd-down { color: var(--red); background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.22); }
.dd-driver, .dd-track { font-size: 0.8rem; color: var(--text-2); line-height: 1.45; margin-top: 4px; }
.dd-track { color: var(--text-3); }

.hero-delta {
  font-size: 0.82rem; font-weight: 600; color: var(--text); margin: 4px 0 6px; line-height: 1.35;
}
.hero-delta.skip { color: var(--text-3); font-weight: 500; }
.hero-card.hero-skip { opacity: 0.96; }

.pos-head, .rel-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.pos-emoji { font-size: 1.5rem; }
.pos-title, .ps-title, .rel-title {
  font-weight: 600; font-size: 0.95rem; color: var(--text); letter-spacing: -0.02em;
}
.pos-sub, .ps-sub, .rel-sub { font-size: 0.72rem; color: var(--text-3); margin-top: 2px; }
.pos-pct { margin-left: auto; font-size: 2rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
.pos-pct-unit { font-size: 0.9rem; font-weight: 600; opacity: 0.7; }
.pos-meter, .ssm-bar, .sc-bar, .fg-bar, .pred-score-meter, .dim-bar-bg {
  height: 6px; background: rgba(0,0,0,0.06); border-radius: 3px; overflow: hidden;
}
.pos-meter { margin-bottom: 10px; height: 8px; }
.pos-fill, .ssm-fill, .sc-fill, .fg-fill, .pred-score-fill, .dim-bar-fill {
  height: 100%; border-radius: 3px; transition: width 0.55s var(--ease);
}
.pos-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.pos-tag, .pred-pill, .sc-mini, .dim-tag, .pos-risk-badge {
  font-size: 0.72rem; font-weight: 500; padding: 4px 10px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline); color: var(--text-2);
}
.pos-headline { font-size: 0.9rem; font-weight: 600; color: var(--text); margin-top: 4px; }
.pos-action { font-size: 0.82rem; color: var(--text-2); margin-top: 6px; line-height: 1.45; }
.pos-risk-badge.hot, .pos-risk-line.hot { color: var(--yellow-text); }
.pos-risk-badge.hot {
  background: rgba(255, 159, 10, 0.12); border-color: rgba(255, 159, 10, 0.28);
}
.pos-risk-line { margin-top: 10px; font-size: 0.8rem; color: var(--text-2); line-height: 1.4; }

.ps-head { margin-bottom: 8px; }
.ps-summary { font-size: 0.82rem; color: var(--text-2); margin: 8px 0 12px; line-height: 1.45; }
.ps-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 10px; margin-bottom: 12px;
}
.ps-grid-core { grid-template-columns: repeat(3, 1fr) !important; }
.ps-card {
  background: var(--glass-inset);
  border: 0.5px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 12px 10px; text-align: center;
}
.ps-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-card); }
.ps-num { font-size: 1.25rem; font-weight: 700; color: var(--gold); letter-spacing: -0.02em; }
.ps-label { font-size: 0.68rem; color: var(--text-2); margin-top: 4px; }
.ps-meta { font-size: 0.65rem; color: var(--text-3); margin-top: 2px; }
.ps-details { margin-top: 8px; font-size: 0.82rem; color: var(--text-2); }
.ps-details summary { cursor: pointer; font-weight: 600; color: var(--text); padding: 6px 0; }
.ps-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.78rem; }
.ps-table th, .ps-table td {
  padding: 6px 8px; text-align: left; border-bottom: 0.5px solid var(--hairline); color: var(--text);
}
.ps-table th { color: var(--text-3); font-weight: 600; font-size: 0.7rem; }
.ps-note { font-size: 0.7rem; color: var(--text-3); margin-top: 10px; line-height: 1.4; }
.ps-subhead { font-size: 0.75rem; font-weight: 600; color: var(--text-2); margin: 12px 0 6px; }
.pred-src {
  margin-left: 8px; font-size: 0.65rem; font-weight: 600; color: var(--text-3);
  background: rgba(0,0,0,0.04); padding: 2px 6px; border-radius: 4px; vertical-align: middle;
}

.rel-approx {
  font-size: 0.65rem; font-weight: 600; color: var(--yellow-text);
  background: rgba(255, 159, 10, 0.12); border: 0.5px solid rgba(255, 159, 10, 0.28);
  padding: 1px 6px; border-radius: 6px;
}
.rel-score-block { text-align: right; }
.rel-score { font-size: 1.5rem; font-weight: 700; color: var(--gold); line-height: 1.1; letter-spacing: -0.02em; }
.rel-score-unit { font-size: 0.85rem; color: var(--text-3); font-weight: 600; }
.rel-label { font-size: 0.75rem; color: var(--text-2); margin-top: 2px; }
.rel-band {
  margin-top: 12px; padding: 8px 12px; border-radius: 10px;
  background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline);
  font-size: 0.88rem; color: var(--text); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.rel-band-label { color: var(--text-3); font-size: 0.75rem; }
.rel-band-center { color: var(--text-2); font-size: 0.78rem; margin-left: auto; }
.rel-tldr { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.rel-tldr-line {
  display: flex; gap: 10px; align-items: flex-start;
  font-size: 0.86rem; color: var(--text); line-height: 1.45;
}
.rel-n {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent); font-size: 0.7rem; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.pred-score-band { font-size: 0.72rem; color: var(--text-2); margin: 2px 0 6px; }

/* 数据质量 / 双打分 */
.dq-banner {
  border-radius: var(--radius-md); padding: 14px 18px; margin-bottom: 14px;
  border: 0.5px solid var(--hairline); font-size: 0.88rem; line-height: 1.45;
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
}
.dq-banner.dq-green { background: rgba(48, 209, 88, 0.12); border-color: rgba(48, 209, 88, 0.28); color: var(--green-text); }
.dq-banner.dq-yellow { background: rgba(255, 159, 10, 0.12); border-color: rgba(255, 159, 10, 0.28); color: var(--yellow-text); }
.dq-banner.dq-red { background: rgba(255, 69, 58, 0.12); border-color: rgba(255, 69, 58, 0.28); color: var(--red-text); }
.dq-main { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; font-weight: 600; }
.dq-emoji { font-size: 1.1rem; }
.dq-conf { font-weight: 600; opacity: 0.9; font-size: 0.82rem; }
.dq-action { margin-top: 6px; font-size: 0.85rem; }
.dq-notes { margin-top: 8px; font-size: 0.78rem; opacity: 0.85; }
.dq-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-left: 6px; vertical-align: middle;
}
.dq-dot-green { background: var(--green); box-shadow: 0 0 0 3px rgba(48,209,88,0.2); }
.dq-dot-yellow { background: var(--yellow); box-shadow: 0 0 0 3px rgba(255,159,10,0.2); }
.dq-dot-red { background: var(--red); box-shadow: 0 0 0 3px rgba(255,69,58,0.2); }

.dual-banner {
  border-radius: var(--radius-md); padding: 12px 16px; margin-bottom: 14px;
  border: 0.5px solid var(--hairline); font-size: 0.85rem;
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
}
.dual-banner.dual-ok { background: rgba(48, 209, 88, 0.1); border-color: rgba(48, 209, 88, 0.25); color: var(--green-text); }
.dual-banner.dual-mild { background: rgba(255, 159, 10, 0.1); border-color: rgba(255, 159, 10, 0.25); color: var(--yellow-text); }
.dual-banner.dual-conflict { background: rgba(0, 122, 255, 0.1); border-color: rgba(0, 122, 255, 0.25); color: var(--blue-text); }
.dual-title { font-weight: 600; margin-bottom: 4px; }
.dual-policy { font-weight: 600; }
.dual-note { font-size: 0.75rem; opacity: 0.8; margin-top: 4px; }

.hero-dq { font-size: 0.75rem; color: var(--text-2); margin-left: 8px; font-weight: 500; }
.rc-conf { font-size: 0.72rem; color: var(--text-3); margin-left: 6px; }
.hero-blocked, .qr-blocked, .pred-hero-blocked { opacity: 0.92; }
.pred-action-blocked { border-style: dashed !important; }
.pred-quant-hint { font-size: 0.68rem; color: var(--gold); margin-top: 4px; }

footer, .footer-meta {
  text-align: center; margin-top: 40px; padding: 24px 0;
  color: var(--text-3); font-size: 0.78rem;
}
footer a, .footer-meta a { color: var(--text-2); text-decoration: none; }
footer a:hover { color: var(--text); }

.hidden { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
/* ===== 三期决策条（短 / 中 / 长） ===== */
.horizon-strip {
  margin: 0 0 14px;
  padding: 16px 18px;
  background: var(--glass-strong);
  border: 0.5px solid var(--hairline);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(20px) saturate(180%);
}
.hz-lead {
  font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em;
  color: var(--text-2); margin-bottom: 12px;
}
.hz-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
}
.hz-cell {
  padding: 14px 16px; border-radius: var(--radius-md);
  background: var(--glass-soft); border: 0.5px solid var(--hairline);
  display: flex; flex-direction: column; gap: 4px;
}
.hz-cell.hz-bull { background: rgba(48,209,88,0.10); border-color: rgba(48,209,88,0.26); }
.hz-cell.hz-bear { background: rgba(255,69,58,0.09); border-color: rgba(255,69,58,0.24); }
.hz-cell.hz-flat { background: rgba(255,159,10,0.09); border-color: rgba(255,159,10,0.24); }
.hz-cell.hz-empty { opacity: 0.6; }
.hz-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hz-title { font-size: 0.98rem; font-weight: 700; color: var(--text); }
.hz-span { font-size: 0.72rem; color: var(--text-3); }
.hz-dir { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.hz-bull .hz-dir { color: var(--green-text); }
.hz-bear .hz-dir { color: var(--red-text); }
.hz-flat .hz-dir { color: var(--yellow-text); }
.hz-score {
  font-size: 1.7rem; font-weight: 700; line-height: 1.1;
  color: var(--text); font-variant-numeric: tabular-nums;
}
.hz-score-unit { font-size: 0.72rem; font-weight: 500; color: var(--text-3); margin-left: 2px; }
.hz-pos { font-size: 0.82rem; color: var(--text); }
.hz-sub { font-size: 0.74rem; color: var(--text-2); }
.hz-note { font-size: 0.78rem; color: var(--text-2); }
.hz-foot {
  margin-top: 12px; padding-top: 10px;
  border-top: 0.5px solid var(--hairline);
  font-size: 0.74rem; line-height: 1.6; color: var(--text-2);
}

/* 宽表在窄屏可横向滚动，避免撑破版心 */
#content table, .ps-table { display: block; overflow-x: auto; max-width: 100%; }

@media (max-width: 860px) {
  .hz-grid { grid-template-columns: 1fr; }
}

`;

const HOME = `
${SHARED}

.container {
  max-width: 980px;
  margin: 0 auto;
  padding: 28px 20px 56px;
}

/* 品牌头 */
header.home-hero {
  text-align: center;
  padding: 8px 0 28px;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px; height: 56px;
  border-radius: 14px;
  background: linear-gradient(145deg, #f5d76e, #c9a227 55%, #a67c00);
  box-shadow:
    0 4px 16px rgba(184, 134, 11, 0.35),
    inset 0 1px 0 rgba(255,255,255,0.45);
  font-size: 1.6rem;
  margin-bottom: 14px;
  animation: brand-in 0.6s var(--ease) both;
}
@keyframes brand-in {
  from { opacity: 0; transform: scale(0.86) translateY(8px); }
  to { opacity: 1; transform: none; }
}
header.home-hero h1 {
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
  margin: 0;
  animation: fade-up 0.55s 0.08s var(--ease) both;
}
header.home-hero .subtitle {
  color: var(--text-2);
  margin-top: 8px;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  animation: fade-up 0.55s 0.16s var(--ease) both;
}
@keyframes fade-up {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

/* 统计 widget 条 */
.stats {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin: 0 0 22px;
  flex-wrap: wrap;
}
.stat-card {
  background: var(--glass);
  backdrop-filter: blur(32px) saturate(160%);
  -webkit-backdrop-filter: blur(32px) saturate(160%);
  border: 0.5px solid var(--hairline-light);
  border-radius: var(--radius-md);
  padding: 14px 20px;
  text-align: center;
  min-width: 88px;
  box-shadow: var(--shadow-card);
}
.stat-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lift);
}
.stat-card .num {
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
}
.stat-card .num.green { color: var(--green-text); }
.stat-card .num.yellow { color: var(--yellow-text); }
.stat-card .num.red { color: var(--red-text); }
.stat-card .num.gold { color: var(--gold); }
.stat-card .label {
  font-size: 0.68rem;
  color: var(--text-3);
  margin-top: 4px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* 工具栏 */
.toolbar {
  display: flex;
  gap: 10px;
  margin: 0 0 16px;
  flex-wrap: wrap;
  align-items: center;
}
.search-box {
  flex: 1;
  min-width: 200px;
  background: var(--glass-strong);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 0.5px solid var(--hairline);
  border-radius: 980px;
  padding: 10px 16px 10px 36px;
  color: var(--text);
  font-size: 0.9rem;
  font-family: inherit;
  outline: none;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.04);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%2386868b' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='6' cy='6' r='4.5'/%3E%3Cpath d='M10 10l3 3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: 14px center;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-box:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft), inset 0 1px 2px rgba(0,0,0,0.04);
}
.search-box::placeholder { color: var(--text-3); }
.sort-btn {
  background: var(--glass);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 0.5px solid var(--hairline);
  border-radius: 980px;
  padding: 9px 14px;
  color: var(--text-2);
  font-size: 0.82rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}
.sort-btn:hover { color: var(--text); transform: translateY(-1px); }
.sort-btn.active {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 4px 14px rgba(0, 122, 255, 0.3);
}
.section-label {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  margin: 18px 0 10px;
  font-weight: 600;
}

/* Hero 最新报告 */
.hero-card {
  display: flex; align-items: center; gap: 20px;
  background: var(--glass-strong);
  backdrop-filter: blur(44px) saturate(180%);
  -webkit-backdrop-filter: blur(44px) saturate(180%);
  border: 0.5px solid var(--hairline-light);
  border-radius: var(--radius-lg);
  padding: 22px 26px;
  margin-bottom: 16px;
  text-decoration: none; color: inherit;
  box-shadow: var(--shadow-window);
  position: relative; overflow: hidden;
}
.hero-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--gold);
  border-radius: 3px 0 0 3px;
}
.hero-card.dir-bullish::before { background: var(--green); }
.hero-card.dir-bearish::before { background: var(--red); }
.hero-card:hover {
  transform: translateY(-4px) scale(1.005);
  box-shadow: var(--shadow-lift);
  text-decoration: none;
  border-color: rgba(0, 122, 255, 0.22);
}
.hero-badge {
  position: absolute; top: 12px; right: 16px;
  font-size: 0.65rem; font-weight: 600; letter-spacing: 0.04em;
  color: var(--gold); background: var(--gold-soft);
  border: 0.5px solid rgba(184, 134, 11, 0.25);
  padding: 3px 10px; border-radius: 980px;
}
.hero-left {
  flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.hero-body { flex: 1; min-width: 0; }
.hero-date { font-size: 0.78rem; color: var(--text-3); letter-spacing: 0.02em; }
.hero-title { font-size: 1.2rem; font-weight: 650; color: var(--text); margin: 4px 0 8px; letter-spacing: -0.02em; }
.hero-verdict { font-size: 1.02rem; font-weight: 650; color: var(--text); margin: 6px 0 8px; line-height: 1.4; }
.hero-action { font-size: 0.88rem; color: var(--text-2); line-height: 1.5; margin-bottom: 4px; }
.hero-quant-chip { display: inline-block; font-size: 0.72rem; font-weight: 600; margin: 4px 0; }
.hero-macro { font-size: 0.82rem; color: var(--blue-text); margin-bottom: 6px; font-weight: 500; }
.hero-short { font-size: 0.82rem; color: var(--text-2); }
.hero-scenarios { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.hero-sample-warn { font-size: 0.75rem; color: var(--yellow-text); margin: 6px 0; }
.hero-dims { margin-top: 10px; }
.hero-arrow {
  font-size: 1.2rem; color: var(--text-3); flex-shrink: 0;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.04);
  transition: background 0.2s, color 0.2s, transform 0.2s var(--ease);
}
.hero-card:hover .hero-arrow {
  background: var(--accent-soft); color: var(--accent); transform: translateX(3px);
}

.sc-mini { background: rgba(0,0,0,0.04); }
.sc-mini.sc-base { color: var(--text-2); }
.sc-mini.sc-up { color: var(--green-text); border-color: rgba(48,209,88,0.3); }
.sc-mini.sc-down { color: var(--red-text); border-color: rgba(255,69,58,0.3); }

.s-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 980px;
  font-weight: 700; font-size: 1.05rem; border: 0.5px solid; white-space: nowrap;
  letter-spacing: -0.02em;
}
.s-badge .s-label { font-size: 0.65rem; font-weight: 500; opacity: 0.85; }

.verdict-chip {
  display: inline-block; font-size: 0.78rem; padding: 4px 10px;
  border-radius: var(--radius-sm); border: 0.5px solid; line-height: 1.35;
  background: var(--glass-inset);
}

.dim-tag {
  display: inline-block; margin: 1px 2px;
  background: rgba(0,0,0,0.03);
}

/* 报告列表 */
.card-grid { display: flex; flex-direction: column; gap: 8px; }
.report-card {
  display: flex; align-items: flex-start; gap: 14px;
  background: var(--glass);
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
  border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  text-decoration: none; color: inherit;
  border-left: 3px solid rgba(0,0,0,0.12);
  box-shadow: var(--shadow-card);
}
.report-card.dir-bullish { border-left-color: var(--green); }
.report-card.dir-bearish { border-left-color: var(--red); }
.report-card.dir-neutral { border-left-color: var(--yellow); }
.report-card.kind-digest { border-left-color: var(--accent); }
.report-card.kind-reflect { border-left-color: #af52de; }
.report-card.kind-other { border-left-color: var(--text-3); }
.report-card:hover {
  background: var(--glass-strong);
  transform: translateY(-2px) scale(1.004);
  box-shadow: var(--shadow-lift);
  text-decoration: none;
  border-color: rgba(0, 122, 255, 0.18);
}
.home-panels {
  margin: 0 0 18px;
  padding-bottom: 8px;
}
.home-panels .pos-panel,
.home-panels .pred-stats-panel,
.home-panels .rel-panel,
.home-panels .dd-panel,
.home-panels .read-panel,
.home-panels .tr-panel {
  margin-left: 14px;
  margin-right: 14px;
  background: rgba(255, 255, 255, 0.55);
}
.home-panels .dd-panel,
.home-panels .rel-panel,
.home-panels .read-panel,
.home-panels .tr-panel { margin-top: 2px; }
.home-panels .pred-stats-panel { margin-bottom: 14px; }
.report-card.hidden { display: none; }
.rc-score {
  flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
}
.rc-score-top { display: inline-flex; align-items: center; }
.rc-quant-badge {
  display: inline-flex; align-items: baseline; gap: 3px;
  padding: 2px 9px; border-radius: 980px;
  font-size: 0.74rem; font-weight: 700; letter-spacing: -0.01em;
  border: 0.5px solid; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.rc-quant-badge .rc-qb-label { font-size: 0.6rem; font-weight: 600; opacity: 0.85; }
.rc-quant-badge.rc-qb-bullish { color: var(--green-text); background: rgba(48, 209, 88, 0.12); border-color: rgba(48, 209, 88, 0.3); }
.rc-quant-badge.rc-qb-neutral { color: var(--yellow-text); background: rgba(255, 159, 10, 0.1); border-color: rgba(255, 159, 10, 0.28); }
.rc-quant-badge.rc-qb-bearish { color: var(--red-text); background: rgba(255, 69, 58, 0.1); border-color: rgba(255, 69, 58, 0.28); }
.rc-body { flex: 1; min-width: 0; }
.rc-date { font-weight: 600; color: var(--text); font-size: 0.95rem; letter-spacing: -0.01em; }
.rc-snippet { font-size: 0.82rem; color: var(--text-2); margin-top: 4px; line-height: 1.45; }
.rc-snippet.muted { color: var(--text-3); font-family: var(--mono); font-size: 0.75rem; }
.rc-meta { font-size: 0.72rem; color: var(--text-3); margin-top: 6px; }
.rc-verdict { margin: 6px 0; }
.rc-dual {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px;
  font-size: 0.78rem; color: var(--text-2); margin-top: 5px; font-weight: 500;
}
.rc-dual-word { color: var(--text-2); font-weight: 600; }
.rc-dual-d { font-variant-numeric: tabular-nums; font-weight: 700; }
.rc-dual-ok { color: var(--text-3); }
.rc-dual-mild { color: var(--yellow-text, #9a6700); }
.rc-dual-conflict { color: var(--red); font-weight: 700; }
.rc-dual-flag {
  font-size: 0.68rem; font-weight: 600; padding: 2px 7px; border-radius: 980px;
  background: rgba(255, 59, 48, 0.1); border: 0.5px solid rgba(255, 59, 48, 0.22); color: var(--red);
}
.rc-delta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-size: 0.76rem; color: var(--text); font-weight: 600; margin-top: 4px; line-height: 1.35;
}
.rc-delta.skip { color: var(--text-3); font-weight: 500; }
.rc-delta-src {
  font-size: 0.65rem; font-weight: 600; padding: 1px 6px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline); color: var(--text-3);
}
.rc-dchips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.rc-dchip {
  font-size: 0.68rem; font-weight: 600; padding: 2px 7px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline); color: var(--text-2);
}
.rc-dchip.rc-d-up { color: var(--green); background: rgba(52, 199, 89, 0.1); border-color: rgba(52, 199, 89, 0.25); }
.rc-dchip.rc-d-down { color: var(--red); background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.22); }
.rc-pos {
  font-size: 0.7rem; font-weight: 600; margin-left: 6px; padding: 2px 8px; border-radius: 980px;
  background: rgba(255, 159, 10, 0.1); border: 0.5px solid rgba(255, 159, 10, 0.22); color: var(--yellow-text, #9a6700);
}
.rc-outcome {
  display: flex; align-items: flex-start; gap: 6px;
  margin-top: 5px; padding: 6px 8px; border-radius: var(--radius-sm);
  font-size: 0.74rem; line-height: 1.4; font-weight: 500;
  background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline); color: var(--text-2);
}
.rc-out-mark { flex-shrink: 0; line-height: 1.35; }
.rc-out-text { flex: 1; min-width: 0; }
.rc-outcome.rc-out-hit {
  background: rgba(52, 199, 89, 0.1); border-color: rgba(52, 199, 89, 0.28); color: var(--green);
}
.rc-outcome.rc-out-miss {
  background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.22); color: var(--red);
}
.rc-outcome.rc-out-pending { color: var(--text-3); }
.rc-outcome.rc-out-flat { color: var(--text-2); }
.hero-card .rc-dual, .hero-card .rc-delta, .hero-card .rc-outcome { margin-top: 6px; }
.rc-kind {
  flex-shrink: 0; align-self: center;
  font-size: 0.68rem; font-weight: 600; letter-spacing: 0.04em;
  color: var(--accent); background: var(--accent-soft);
  border: 0.5px solid rgba(0,122,255,0.2);
  padding: 6px 10px; border-radius: var(--radius-sm);
}

.empty {
  text-align: center; padding: 60px 20px;
  background: var(--glass); border-radius: var(--radius-lg);
  border: 0.5px solid var(--hairline); color: var(--text-2);
  backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
}
.empty .icon { font-size: 2.5rem; margin-bottom: 16px; opacity: 0.7; }
.empty code {
  background: rgba(0,0,0,0.05); padding: 2px 8px; border-radius: 4px;
  font-family: var(--mono); font-size: 0.85em;
}

@media (max-width: 768px) {
  .container { padding: 16px 14px 40px; }
  header.home-hero h1 { font-size: 1.65rem; }
  .stats { gap: 8px; }
  .stat-card { padding: 12px 14px; min-width: 72px; }
  .hero-card { flex-direction: column; align-items: flex-start; padding: 18px; }
  .hero-arrow { display: none; }
  .ps-grid-core { grid-template-columns: 1fr !important; }
}
`;

const ARTICLE = `
${SHARED}

body { line-height: 1.7; }

/* 顶部菜单栏 */
.topbar {
  position: sticky; top: 0; z-index: 100;
  height: 48px;
  padding: 0 20px;
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border-bottom: 0.5px solid var(--hairline);
  box-shadow: 0 1px 0 rgba(255,255,255,0.5);
}
.topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.topbar a {
  color: var(--text-2); text-decoration: none; font-size: 0.88rem;
  display: flex; align-items: center; gap: 6px;
  transition: color 0.15s;
}
.topbar a:hover { color: var(--accent); text-decoration: none; }
.topbar .logo {
  font-weight: 650; font-size: 0.95rem; color: var(--text);
  letter-spacing: -0.02em;
}
.topbar .logo-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: linear-gradient(145deg, #f5d76e, #c9a227);
  box-shadow: 0 0 0 2px rgba(184,134,11,0.2);
  flex-shrink: 0;
}
.topbar .sep { color: var(--text-3); font-size: 0.75rem; }
.topbar .report-date {
  color: var(--text-3); font-size: 0.82rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.topbar-back {
  padding: 5px 12px; border-radius: 980px;
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline);
  font-size: 0.8rem !important;
  transition: background 0.15s, transform 0.15s var(--ease);
}
.topbar-back:hover {
  background: var(--accent-soft); transform: translateX(-2px);
}

.article-layout {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 24px 72px;
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

/* 侧栏玻璃 */
.sidebar {
  position: sticky; top: 68px;
  width: 220px; flex-shrink: 0;
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--glass);
  backdrop-filter: blur(36px) saturate(170%);
  -webkit-backdrop-filter: blur(36px) saturate(170%);
  border: 0.5px solid var(--hairline-light);
  box-shadow: var(--shadow-card);
}
.score-gauge { text-align: center; margin-bottom: 16px; }
.sg-circle {
  width: 112px; height: 112px; border-radius: 50%;
  margin: 0 auto 10px;
  display: flex; align-items: center; justify-content: center;
  position: relative;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.04);
}
.sg-inner {
  width: 84px; height: 84px; border-radius: 50%;
  background: var(--glass-strong);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  box-shadow: var(--shadow-card);
}
.sg-score { font-size: 1.7rem; font-weight: 700; color: var(--text); line-height: 1; letter-spacing: -0.03em; }
.sg-label { font-size: 0.68rem; color: var(--text-3); }
.sg-direction { font-size: 0.82rem; color: var(--text-2); margin-top: 4px; }

.dim-bar-row {
  display: flex; align-items: center; gap: 8px;
  margin: 6px 0; font-size: 0.78rem;
}
.dim-name { width: 36px; color: var(--text-2); flex-shrink: 0; }
.dim-val { width: 24px; text-align: right; color: var(--text-3); }

.sidebar-block { margin-top: 16px; padding-top: 14px; border-top: 0.5px solid var(--hairline); }
.sb-title {
  font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-3); margin-bottom: 10px; font-weight: 600;
}
.sidebar-more {
  margin-top: 14px; width: 100%;
  background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 8px 10px;
}
.sidebar-more > summary {
  cursor: pointer; font-size: 0.72rem; color: var(--text-2); list-style: none;
  padding: 4px 2px; user-select: none;
}
.sidebar-more > summary::-webkit-details-marker { display: none; }
.sidebar-more[open] > summary { color: var(--accent); margin-bottom: 8px; }

.sidebar-score-meter { margin-bottom: 14px; }
.ssm-label { font-size: 0.75rem; color: var(--text-3); margin-bottom: 4px; }
.ssm-bar { margin-bottom: 4px; height: 8px; }
.ssm-dir { font-size: 0.82rem; color: var(--text-2); }

.toc { display: flex; flex-direction: column; gap: 2px; }
.toc-link {
  color: var(--text-2); text-decoration: none; font-size: 0.78rem;
  padding: 6px 8px; border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}
.toc-link:hover { background: rgba(0,0,0,0.04); color: var(--text); text-decoration: none; }
.toc-link.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

.macro-label { font-weight: 650; color: var(--blue-text); font-size: 0.88rem; }
.macro-desc { font-size: 0.72rem; color: var(--text-3); margin-top: 4px; line-height: 1.4; }
.judge-text { font-size: 0.72rem; color: var(--text-2); line-height: 1.45; }
.sim-row {
  display: flex; justify-content: space-between; font-size: 0.68rem;
  color: var(--text-2); padding: 4px 0; border-bottom: 0.5px solid var(--hairline);
}
.sim-row span:first-child { color: var(--text); }
.sim-row span.up { color: var(--green-text); font-weight: 600; }
.sim-row span.down { color: var(--red-text); font-weight: 600; }
.sim-summary { font-size: 0.72rem; color: var(--green-text); margin-bottom: 8px; line-height: 1.4; }

/* 瀑布 */
.waterfall { display: flex; flex-direction: column; gap: 6px; }
.wf-row {
  background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 0.72rem;
}
.wf-row.wf-sub { background: rgba(0,0,0,0.02); }
.wf-row.wf-final { border-color: rgba(184,134,11,0.3); background: var(--gold-soft); }
.wf-step { font-weight: 600; color: var(--text); }
.wf-detail { color: var(--text-3); margin-top: 2px; font-size: 0.68rem; }
.wf-meta { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
.wf-delta { font-weight: 700; font-size: 0.78rem; }
.wf-delta.up { color: var(--green-text); }
.wf-delta.down { color: var(--red-text); }
.wf-delta.neutral { color: var(--text-2); }
.wf-total { color: var(--gold); font-weight: 700; margin-left: auto; }

.sample-warn {
  margin-bottom: 12px; padding: 10px 14px;
  background: rgba(255, 159, 10, 0.12); border: 0.5px solid rgba(255,159,10,0.28);
  border-radius: var(--radius-sm); color: var(--yellow-text); font-size: 0.82rem; line-height: 1.45;
}
.sample-warn strong { color: var(--yellow-text); }

.pred-secondary {
  margin-top: 14px; background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md); padding: 10px 14px;
}
.pred-secondary > summary {
  cursor: pointer; color: var(--text-2); font-size: 0.82rem; list-style: none; user-select: none;
}
.pred-secondary > summary::-webkit-details-marker { display: none; }
.pred-secondary[open] > summary { color: var(--accent); margin-bottom: 8px; }
.sc-desc { margin-top: 8px; font-size: 0.72rem; color: var(--text-3); }
.sc-desc > summary { cursor: pointer; color: var(--text-2); }
.sc-desc p { margin-top: 6px; line-height: 1.45; color: var(--text-2); }

/* 折叠工具条 */
.collapse-toolbar {
  display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; justify-content: center;
}
.collapse-btn {
  background: var(--glass-strong); border: 0.5px solid var(--hairline); color: var(--text-2);
  border-radius: 980px; padding: 6px 14px; font-size: 0.78rem; cursor: pointer;
  font-family: inherit;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  transition: all 0.18s var(--ease);
}
.collapse-btn:hover {
  color: var(--text); border-color: rgba(0,122,255,0.35);
  background: var(--accent-soft); transform: translateY(-1px);
}

.md-section {
  margin: 12px 0 14px;
  background: var(--glass);
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
  border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md);
  overflow: hidden;
  scroll-margin-top: 72px;
  box-shadow: var(--shadow-card);
}
.md-section[open] { box-shadow: var(--shadow-window); }
.md-section-summary {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  cursor: pointer; list-style: none; user-select: none;
  padding: 12px 14px;
  background: rgba(255,255,255,0.35);
  border-left: 3px solid var(--gold);
  color: var(--text); font-weight: 600; font-size: 0.95rem;
  letter-spacing: -0.01em;
  transition: background 0.15s;
}
.md-section-summary:hover { background: rgba(255,255,255,0.55); }
.md-section-summary::-webkit-details-marker { display: none; }
.md-section[data-sec-kind="short-strategy"] .md-section-summary,
.md-section[data-sec-kind="mid-strategy"] .md-section-summary,
.md-section[data-sec-kind="scenarios"] .md-section-summary {
  border-left-color: var(--green);
}
.md-section[data-sec-kind="rebuttal"] .md-section-summary,
.md-section[data-sec-kind="tail-risk"] .md-section-summary {
  border-left-color: var(--red);
}
.md-sec-hint::after {
  content: '展开'; color: var(--text-3); font-size: 0.72rem; font-weight: 500;
  padding: 3px 8px; border-radius: 980px; background: rgba(0,0,0,0.04);
}
.md-section[open] > .md-section-summary .md-sec-hint::after {
  content: '收起'; color: var(--accent); background: var(--accent-soft);
}
.md-section-body {
  padding: 4px 16px 16px;
  animation: sec-open 0.28s var(--ease);
}
@keyframes sec-open {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.md-more-list, .md-cell-more {
  margin: 8px 0; padding: 8px 10px;
  background: rgba(0,0,0,0.03); border-radius: var(--radius-sm);
  border: 0.5px solid var(--hairline);
}
.md-more-list > summary, .md-cell-more > summary {
  cursor: pointer; color: var(--text-2); font-size: 0.8rem; list-style: none;
}
.md-more-list > summary::-webkit-details-marker,
.md-cell-more > summary::-webkit-details-marker { display: none; }
.md-cell-full { margin-top: 8px; color: var(--text); font-size: 0.85rem; line-height: 1.5; }

/* 预测仪表盘 */
.pred-dashboard { margin-bottom: 24px; }
.pred-hero {
  display: grid; grid-template-columns: 120px 1fr auto; gap: 24px; align-items: start;
  background: var(--glass-strong);
  backdrop-filter: blur(44px) saturate(180%);
  -webkit-backdrop-filter: blur(44px) saturate(180%);
  border: 0.5px solid var(--hairline-light);
  border-left: 3px solid var(--pred-color, var(--gold));
  border-radius: var(--radius-lg); padding: 22px 26px;
  box-shadow: var(--shadow-window);
}
.pred-score-num {
  font-size: 4rem; font-weight: 700; color: var(--text); line-height: 1;
  letter-spacing: -0.04em;
}
.pred-score-sub { font-size: 0.72rem; color: var(--text-3); margin-top: 4px; }
.pred-score-meter { margin-top: 10px; }
.pred-quant-bar {
  display: flex; align-items: center; gap: 8px;
  margin-top: 10px; padding: 6px 10px;
  background: rgba(0,0,0,0.03); border-radius: var(--radius-sm);
  border: 0.5px solid var(--hairline);
}
.pred-quant-label { font-size: 0.7rem; color: var(--text-3); }
.pred-quant-value { font-size: 1rem; font-weight: 700; color: var(--text-2); }
.pred-quant-diff { font-size: 0.72rem; font-weight: 600; }
.qr-quant {
  display: block; text-align: center;
  font-size: 0.65rem; color: var(--text-3); padding: 2px 0;
}
.qr-dq { display: block; text-align: center; font-size: 0.65rem; margin-top: 4px; color: var(--text-2); }
.qr-dq-green { color: var(--green-text); }
.qr-dq-yellow { color: var(--yellow-text); }
.qr-dq-red { color: var(--red-text); }

.pred-emoji { font-size: 1.4rem; margin-bottom: 4px; }
.pred-headline { font-size: 1.3rem; color: var(--text); font-weight: 650; margin-bottom: 6px; line-height: 1.35; letter-spacing: -0.02em; }
.pred-tag { font-size: 0.82rem; color: var(--pred-color, var(--gold)); font-weight: 600; margin-bottom: 12px; }
.pred-action-box {
  background: rgba(255,255,255,0.5);
  border: 1.5px solid var(--pred-color, var(--gold));
  border-radius: var(--radius-md); padding: 14px 16px;
  box-shadow: var(--shadow-card);
}
.pred-action-label { font-size: 0.65rem; color: var(--text-3); letter-spacing: 0.04em; text-transform: uppercase; }
.pred-action-text { font-size: 1.05rem; color: var(--text); margin-top: 4px; font-weight: 600; line-height: 1.5; }
.pred-macro { font-size: 0.78rem; color: var(--blue-text); margin-top: 10px; }
.pred-macro-inline { font-size: 0.72rem; color: var(--blue-text); margin-top: 6px; }
.pred-dir-tag { font-size: 1.05rem; font-weight: 700; color: var(--pred-color, var(--gold)); margin-bottom: 10px; }
.pred-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.pred-calib-badge {
  margin-top: 10px; padding: 6px 10px;
  background: rgba(0,0,0,0.03); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-sm); font-size: 0.7rem; color: var(--text-2); line-height: 1.4;
}
.pred-meta-col { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.pred-pill.conf-good { color: var(--green-text); border-color: rgba(48,209,88,0.35); background: rgba(48,209,88,0.08); }
.pred-pill.conf-mid { color: var(--yellow-text); border-color: rgba(255,159,10,0.35); background: rgba(255,159,10,0.08); }
.pred-pill.conf-low { color: var(--red-text); border-color: rgba(255,69,58,0.35); background: rgba(255,69,58,0.08); }

.pred-trust {
  display: flex; gap: 12px; align-items: flex-start;
  margin-top: 14px; padding: 14px 18px;
  background: var(--glass); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text); line-height: 1.5;
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.pred-trust-muted { color: var(--text-3); }
.pred-trust-icon { font-size: 1.2rem; flex-shrink: 0; }
.pred-trust strong { color: var(--gold); }
.pred-section-title {
  font-size: 0.72rem; color: var(--text-3); letter-spacing: 0.06em;
  text-transform: uppercase; margin: 18px 0 12px; font-weight: 600;
}
.sc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.sc-card {
  background: var(--glass); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md); padding: 14px 16px;
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow-card);
}
.sc-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.sc-card.sc-up { border-top: 3px solid var(--green); }
.sc-card.sc-down { border-top: 3px solid var(--red); }
.sc-card.sc-base { border-top: 3px solid var(--text-3); }
.sc-head { display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.sc-pct { font-size: 1.1rem; color: var(--gold); }
.sc-bar { margin-bottom: 10px; }
.sc-fill { background: linear-gradient(90deg, #c9a227, #e8c547); }
.sc-card.sc-up .sc-fill { background: linear-gradient(90deg, #1a7f37, #30d158); }
.sc-card.sc-down .sc-fill { background: linear-gradient(90deg, #c62828, #ff453a); }
.sc-action { font-size: 0.78rem; color: var(--text-2); line-height: 1.45; }
.pred-short-tip {
  margin-top: 14px; padding: 12px 16px;
  background: var(--gold-soft); border-radius: var(--radius-sm);
  font-size: 0.85rem; color: var(--text-2); line-height: 1.5;
  border-left: 3px solid var(--gold);
}
.pred-short-tip span { color: var(--gold); font-weight: 600; margin-right: 8px; }

.glance-bar {
  display: flex; flex-wrap: wrap; gap: 12px 20px;
  background: var(--glass); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md); padding: 16px 20px; margin-bottom: 24px;
  backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
}
.gb-item { font-size: 0.85rem; color: var(--text); line-height: 1.45; flex: 1; min-width: 140px; }
.gb-item.gb-score { font-size: 1.8rem; font-weight: 700; flex: 0; min-width: auto; letter-spacing: -0.03em; }
.gb-item.gb-score span { font-size: 0.9rem; color: var(--text-3); font-weight: 500; }
.gb-item.gb-dir { flex: 0; min-width: auto; align-self: center; font-weight: 600; }
.gb-label { display: block; font-size: 0.65rem; color: var(--text-3); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 2px; }
.gb-judge { flex: 1 1 100%; font-size: 0.8rem; color: var(--text-2); }

.article-main { flex: 1; min-width: 0; }
.article-shell {
  border-radius: var(--radius-lg);
  background: var(--glass-strong);
  backdrop-filter: blur(44px) saturate(180%);
  -webkit-backdrop-filter: blur(44px) saturate(180%);
  border: 0.5px solid var(--hairline-light);
  box-shadow: var(--shadow-window);
  overflow: hidden;
  padding: 0 0 8px;
  animation: window-in 0.45s var(--ease) both;
}
@keyframes window-in {
  from { opacity: 0; transform: translateY(12px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.article-header {
  text-align: center;
  padding: 8px 24px 20px;
  margin-bottom: 8px;
  border-bottom: 0.5px solid var(--hairline);
}
.article-header h1 {
  font-size: 1.45rem; color: var(--text); font-weight: 650; letter-spacing: -0.02em;
}
.article-header .meta { margin-top: 6px; color: var(--text-3); font-size: 0.82rem; }

#content { font-size: 0.98rem; color: var(--text); padding: 0 22px 8px; }
#content h2 {
  font-size: 1.1rem; color: var(--text); margin: 28px 0 12px;
  padding: 10px 14px; background: rgba(0,0,0,0.03); border-radius: var(--radius-sm);
  border-left: 3px solid var(--gold); scroll-margin-top: 72px;
  letter-spacing: -0.01em;
}
#content h2:first-child { margin-top: 0; }
#content h3 { font-size: 1.05rem; color: var(--text); margin: 20px 0 8px; }
#content h4 { font-size: 1rem; color: var(--text); margin: 16px 0 6px; }
#content p { margin: 10px 0; }
#content strong { color: var(--text); font-weight: 600; }
#content a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(0,122,255,0.25); }
#content a:hover { border-bottom-color: var(--accent); }
#content table {
  width: 100%; border-collapse: collapse; margin: 14px 0;
  background: rgba(255,255,255,0.45); border-radius: var(--radius-sm);
  overflow: hidden; font-size: 0.88rem;
  border: 0.5px solid var(--hairline);
}
#content th {
  background: rgba(0,0,0,0.03); padding: 10px 14px; text-align: left;
  color: var(--text-3); font-weight: 600; font-size: 0.78rem;
  letter-spacing: 0.03em; text-transform: uppercase;
}
#content td { padding: 10px 14px; border-top: 0.5px solid var(--hairline); }
#content code {
  font-family: var(--mono); font-size: 0.88em;
  background: rgba(0,0,0,0.05); padding: 2px 7px; border-radius: 4px; color: var(--text);
}
#content pre {
  background: rgba(0,0,0,0.04); border: 0.5px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 14px 18px; margin: 14px 0; overflow-x: auto;
}
#content pre code { background: transparent; padding: 0; font-size: 0.85rem; }
#content blockquote {
  border-left: 3px solid var(--gold); background: var(--gold-soft);
  padding: 10px 16px; margin: 12px 0; border-radius: 0 8px 8px 0; color: var(--text-2);
}
#content ul, #content ol { margin: 6px 0; padding-left: 24px; }
#content li { margin: 4px 0; }
#content hr { border: none; height: 0.5px; background: var(--hairline); margin: 24px 0; }
.equity-chart { margin: 18px 0; overflow-x: auto; }
.equity-chart svg { display: block; max-width: 100%; height: auto; border-radius: 8px; }

.footer-meta {
  margin: 24px 22px 16px; padding-top: 16px;
  border-top: 0.5px solid var(--hairline);
}

.quick-read-card {
  display: flex; gap: 20px; max-width: 720px; margin: 0 auto 16px;
  background: var(--glass-strong);
  backdrop-filter: blur(36px) saturate(170%);
  -webkit-backdrop-filter: blur(36px) saturate(170%);
  border: 0.5px solid var(--hairline); border-radius: var(--radius-md);
  padding: 18px 22px; border-left-width: 3px;
  box-shadow: var(--shadow-card);
}
.qr-left { flex-shrink: 0; text-align: center; }
.qr-score { font-size: 2.8rem; font-weight: 700; color: var(--text); line-height: 1; letter-spacing: -0.04em; }
.qr-score .qr-total { font-size: 1.1rem; color: var(--text-3); font-weight: 500; }
.qr-dir { font-size: 0.9rem; font-weight: 600; margin-top: 6px; }
.qr-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.qr-action { font-size: 1.05rem; color: var(--text); font-weight: 600; line-height: 1.4; }
.qr-why { font-size: 0.8rem; color: var(--text-2); }
.qr-warn { font-size: 0.75rem; color: var(--yellow-text); }

.flow-dashboard { margin-bottom: 24px; }
.flow-hero {
  display: flex; gap: 28px; align-items: center;
  background: var(--glass-strong);
  backdrop-filter: blur(40px) saturate(170%);
  -webkit-backdrop-filter: blur(40px) saturate(170%);
  border: 0.5px solid var(--hairline-light);
  border-radius: var(--radius-lg); padding: 24px 28px;
  box-shadow: var(--shadow-window);
}
.flow-main-score { text-align: center; flex-shrink: 0; }
.flow-big-num { font-size: 4rem; font-weight: 700; line-height: 1; letter-spacing: -0.04em; }
.flow-big-label { font-size: 0.75rem; color: var(--text-3); margin-top: 6px; letter-spacing: 0.06em; text-transform: uppercase; }
.flow-gauges { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.flow-gauge { display: flex; align-items: center; gap: 12px; }
.fg-label { width: 48px; font-size: 0.78rem; color: var(--text-2); flex-shrink: 0; }
.fg-score { width: 32px; font-size: 0.9rem; font-weight: 700; color: var(--text); text-align: right; flex-shrink: 0; }
.fg-fill { background: var(--gold); }
.flow-gauge.bullish .fg-fill { background: var(--green); }
.flow-gauge.bearish .fg-fill { background: var(--red); }
.flow-gauge.neutral .fg-fill { background: var(--yellow); }
.flow-warning {
  margin-top: 12px; padding: 10px 16px;
  background: rgba(255,159,10,0.12); border: 0.5px solid rgba(255,159,10,0.28);
  border-radius: var(--radius-sm); color: var(--yellow-text); font-size: 0.82rem;
}

@media (max-width: 860px) {
  .pred-hero { grid-template-columns: 1fr; }
  .pred-meta-col { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .sc-grid { grid-template-columns: 1fr; }
  .article-layout { flex-direction: column; padding: 16px 12px 48px; gap: 14px; }
  .sidebar { position: static; width: 100%; }
  .article-header h1 { font-size: 1.25rem; }
  #content { font-size: 0.94rem; padding: 0 14px 8px; }
  .topbar { padding: 0 12px; }
  .flow-hero { flex-direction: column; }
  .ps-grid-core { grid-template-columns: 1fr !important; }
}
`;

module.exports = {
  homeCss: HOME,
  articleCss: ARTICLE,
};
