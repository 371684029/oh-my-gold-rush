// GoldRush 桌面版 — 在进程内启动 server.cjs（仅 127.0.0.1 随机端口），用窗口展示日报站

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_DIR = path.join(__dirname, 'bundle');
const BUNDLED_DOCS = path.join(BUNDLE_DIR, 'docs');

function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

/** 优先级：环境变量 > 用户在菜单里选的目录 > 打包时内置的报告快照 */
function resolveDocsDir() {
  if (process.env.GOLDRUSH_DOCS_DIR) return process.env.GOLDRUSH_DOCS_DIR;
  const { docsDir } = readConfig();
  if (docsDir && fs.existsSync(docsDir)) return docsDir;
  return BUNDLED_DOCS;
}

function startServer(docsDir) {
  process.env.GOLDRUSH_EMBEDDED = '1';
  process.env.GOLDRUSH_DOCS_DIR = docsDir;
  const { server } = require(path.join(BUNDLE_DIR, 'server.cjs'));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

function isLocal(url, baseUrl) {
  return url.startsWith(baseUrl);
}

function buildMenu(win, baseUrl, docsDir) {
  const relaunch = () => {
    app.relaunch();
    app.exit(0);
  };
  const template = [
    {
      label: '报告',
      submenu: [
        { label: '首页', accelerator: 'CmdOrCtrl+H', click: () => win.loadURL(baseUrl) },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
        { type: 'separator' },
        {
          label: '选择报告目录（docs/）…',
          click: async () => {
            const r = await dialog.showOpenDialog(win, {
              title: '选择包含 goldrush-analysis-*.md 的 docs 目录',
              properties: ['openDirectory'],
            });
            if (r.canceled || !r.filePaths[0]) return;
            writeConfig({ ...readConfig(), docsDir: r.filePaths[0] });
            relaunch();
          },
        },
        {
          label: '恢复内置报告快照',
          enabled: docsDir !== BUNDLED_DOCS,
          click: () => {
            const cfg = readConfig();
            delete cfg.docsDir;
            writeConfig(cfg);
            relaunch();
          },
        },
        { label: `当前目录：${docsDir === BUNDLED_DOCS ? '内置快照' : docsDir}`, enabled: false },
        { type: 'separator' },
        { label: '在浏览器中打开', click: () => shell.openExternal(win.webContents.getURL() || baseUrl) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ];
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const docsDir = resolveDocsDir();
  let baseUrl;
  try {
    baseUrl = await startServer(docsDir);
  } catch (err) {
    dialog.showErrorBox('GoldRush 启动失败', `内置报告服务无法启动：\n${err && err.stack ? err.stack : err}`);
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'GoldRush',
    backgroundColor: '#0b0b0f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url, baseUrl)) {
      win.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isLocal(url, baseUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  buildMenu(win, baseUrl, docsDir);
  await win.loadURL(baseUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
