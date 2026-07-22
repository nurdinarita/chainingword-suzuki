const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// === Helper: ambil nama event dari route.json, ENV, atau CLI ===
function getEventName() {
  try {
    const routePath = path.join(__dirname, 'route.json'); // <- file yang kamu sebut
    if (fs.existsSync(routePath)) {
      const data = JSON.parse(fs.readFileSync(routePath, 'utf8'));
      if (data && (data.route || data.name)) {
        return String(data.route || data.name).trim();
      }
    }
  } catch (e) {
    console.warn('⚠️ Tidak bisa baca route.json:', e.message);
  }

  const fromEnv = process.env.EVENT_NAME && String(process.env.EVENT_NAME).trim();
  if (fromEnv) return fromEnv;
  const arg = process.argv.find(a => a.startsWith('--event='));
  if (arg) return arg.split('=')[1] || 'default';
  return 'default';
}

// === Helper: resolve asset (dev & packaged) ===
function resolveEventAsset(eventName, filename) {
  const devPath = path.join(__dirname, 'public', eventName, filename);
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath || '', 'public', eventName, filename);
  if (fs.existsSync(prodPath)) return prodPath;
  return null;
}

// === Helper: cari splash file dengan prioritas ===
function resolveSplashImage(eventName) {
  const candidates = [
    'splash.png',
    'splash.jpg',
    'splash.jpeg',
    'splash.webp',
    'icon.png',        // fallback
  ];
  for (const file of candidates) {
    const p = resolveEventAsset(eventName, file);
    if (p) return p;
  }
  return null;
}

// === Helper: file -> data URL (auto mime by ext) ===
function fileToDataUrl(absPath) {
  try {
    const ext = (path.extname(absPath) || '').toLowerCase();
    const mime =
      ext === '.png'  ? 'image/png'  :
      ext === '.jpg'  ? 'image/jpeg' :
      ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      'application/octet-stream';
    const buf = fs.readFileSync(absPath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

let serverProcess;
let mainWin;
let splashWin;

function createSplash() {
  const eventName = getEventName();

  // cari gambar splash full-screen
  const splashFile = resolveSplashImage(eventName);
  const splashDataUrl = splashFile ? fileToDataUrl(splashFile) : '';

  // (opsional) set icon window untuk OS: pakai icon.png jika ada
  const iconForWindow = resolveEventAsset(eventName, 'icon.png') || path.join(__dirname, 'icon.ico');

  splashWin = new BrowserWindow({
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: 'rgba(255, 0, 0, 0)', // tetap merah jika tidak ada gambar
    icon: iconForWindow,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // HTML: jika ada gambar -> tampilkan <img> full-screen (cover). Jika tidak ada -> tetap background merah + teks.
  const hasSplash = Boolean(splashDataUrl);

  splashWin.loadURL(
    `data:text/html;charset=UTF-8,` +
    encodeURIComponent(
`<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,body{height:100%;margin:0}
      body{
        background:rgba(255, 0, 0, 0);
        font-family: monospace; color:#fff;
        display:flex; align-items:center; justify-content:center;
        overflow:hidden;
      }
      .bg {
        position: absolute; top: 50%; left: 50%;
        width: auto; height: auto;
        max-width: 100vw; 
        max-height: 100vh; 
        transform: translate(-50%, -50%);
        object-fit: contain;
        object-position: center center;
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
        background: rgba(255, 0, 0, 0);
      }

      .loading {
        position:relative; z-index:2;
        font-size:2rem; text-shadow:0 2px 8px rgba(0,0,0,0.6);
        display:${hasSplash ? 'none' : 'block'};
        animation:blink 1s infinite;
      }
      @keyframes blink { 50% { opacity:.35 } }
    </style>
  </head>
  <body>
    <img class="bg" src="${splashDataUrl}" alt="splash">
    <div class="loading">Loading Game...</div>
  </body>
</html>`
    )
  );

  splashWin.setAlwaysOnTop(true, 'screen-saver');
  splashWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  splashWin.setFullScreen(true);
}

// === createMainWindow(), app.whenReady(), dst (tetap sama) ===

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    fullscreen: true,
    kiosk: true,
    frame: false,
    movable: false,
    resizable: false,
    alwaysOnTop: true,
    focusable: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      zoomFactor: 1.0
    }
  });

  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWin.setFullScreen(true);
  mainWin.setKiosk(true);
  mainWin.focus();

  // buka URL setelah server siap
  mainWin.loadURL('http://localhost:8980/');

  // nonaktifkan zoom dan shortcut zoom
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.setVisualZoomLevelLimits(1, 1);
    mainWin.webContents.setZoomFactor(1);
  });

  mainWin.webContents.on('before-input-event', (event, input) => {
    // blok zoom + refresh + devtools
    if (
      (input.control && ['+', '-', '0', 'r', 'R', 'i', 'I', 'j', 'J'].includes(input.key)) ||
      (input.key === 'F11') ||
      (input.key === 'F12')
    ) {
      event.preventDefault();
    }
  });

  // cegah kehilangan fokus (auto refocus)
  const keepFocus = setInterval(() => {
    if (mainWin && !mainWin.isFocused()) {
      mainWin.focus();
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 500);

  // pastikan tetap fullscreen
  mainWin.on('leave-full-screen', () => mainWin.setFullScreen(true));

  mainWin.on('closed', () => clearInterval(keepFocus));
}

app.whenReady().then(() => {
  // Shortcut admin (Ctrl+Q)
  globalShortcut.register('Control+Q', () => {
    console.log('CTRL + Q ditekan → keluar aplikasi.');
    app.quit();
  });

  // tampilkan splash
  createSplash();

  // jalankan server backend (express, dll)
  serverProcess = spawn('node', [path.join(__dirname, 'app-default.js')], {
    stdio: 'inherit'
  });

  // tunggu server siap
  setTimeout(() => {
    if (splashWin) splashWin.close();
    createMainWindow();
  }, 4000);
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
