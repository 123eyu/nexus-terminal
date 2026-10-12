// packages/desktop/scripts/build-desktop.js
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

async function main() {
  console.log('🚀 [Desktop Packager] 开始全量构建 Nexus Terminal 桌面端 (Tauri v2 + Node Sidecar)...');

  const desktopDir = path.resolve(__dirname, '..');
  const rootDir = path.resolve(desktopDir, '../..');
  const portableDir = path.join(rootDir, 'dist-desktop', 'portable');

  // 1. 确保 Cargo/Rust 与 Node 环境在 PATH 中
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const cargoHome = process.env.CARGO_HOME || (userProfile ? path.join(userProfile, '.cargo') : '');
  const cargoBin = cargoHome ? path.join(cargoHome, 'bin') : '';
  const nodeBin = path.dirname(process.execPath);

  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const currentPath = process.env[pathKey] || '';
  const extraPaths = [cargoBin, nodeBin].filter(p => p && fs.existsSync(p));
  const newPath = extraPaths.length > 0 ? `${extraPaths.join(path.delimiter)}${path.delimiter}${currentPath}` : currentPath;

  const env = { ...process.env };
  env[pathKey] = newPath;
  env.PATH = newPath;
  env.Path = newPath;

  // 2. 准备自包含 Sidecar 和最新 Web 静态资源
  console.log('\n📦 第一步：准备 Node.js Sidecar 与前后端全量生产资源...');
  execSync(`"${process.execPath}" scripts/build-sidecar.js`, {
    cwd: desktopDir,
    env,
    shell: true,
    stdio: 'inherit'
  });

  // 3. 执行 Tauri 构建打包
  const isQuick = process.argv.includes('--quick') || process.argv.includes('--no-bundle') || process.env.FAST_BUILD === '1';
  const tauriBuildCmd = isQuick ? 'npx @tauri-apps/cli build --no-bundle' : 'npx @tauri-apps/cli build';
  console.log(`\n🦀 第二步：执行 Tauri 构建打包 (${tauriBuildCmd})...`);
  execSync(tauriBuildCmd, {
    cwd: desktopDir,
    env,
    shell: true,
    stdio: 'inherit'
  });

  // 4. 将生成的最新可执行文件覆盖到便携包
  console.log('\n🚚 第三步：同步最新自包含二进制与服务资源至便携版目录 (dist-desktop/portable)...');
  fs.mkdirSync(portableDir, { recursive: true });

  const releaseExeCandidate1 = path.join(desktopDir, 'src-tauri', 'target', 'release', 'nexus-terminal-desktop.exe');
  const releaseExeCandidate2 = path.join(desktopDir, 'src-tauri', 'target', 'release', 'Nexus Terminal.exe');
  const releaseExe = fs.existsSync(releaseExeCandidate1) ? releaseExeCandidate1 : releaseExeCandidate2;
  const targetPortableExe = path.join(portableDir, 'Nexus Terminal.exe');

  if (fs.existsSync(releaseExe)) {
    fs.copyFileSync(releaseExe, targetPortableExe);
    console.log(`✅ 已更新便携版主执行文件: ${targetPortableExe} (源: ${path.basename(releaseExe)})`);
  } else {
    console.warn(`⚠️ 未找到生成的主执行文件: ${releaseExe}`);
  }

  // 4.1 同步 Node.js Sidecar 运行时二进制 (提供双名称保障 100% 命中)
  const candidateSidecars = [
    path.join(desktopDir, 'src-tauri', 'target', 'release', 'nexus-server.exe'),
    path.join(desktopDir, 'src-tauri', 'binaries', 'nexus-server-x86_64-pc-windows-msvc.exe'),
    process.execPath
  ];
  const validSidecar = candidateSidecars.find(p => fs.existsSync(p));
  if (validSidecar) {
    const portableSidecar1 = path.join(portableDir, 'nexus-server.exe');
    const portableSidecar2 = path.join(portableDir, 'nexus-server-x86_64-pc-windows-msvc.exe');
    fs.copyFileSync(validSidecar, portableSidecar1);
    fs.copyFileSync(validSidecar, portableSidecar2);
    console.log(`✅ 已部署便携版 Node 运行时: ${portableSidecar1} 与 ${portableSidecar2}`);
  } else {
    console.error('❌ 未找到可用的 nexus-server Node 运行时二进制！');
  }

  // 4.2 镜像同步完整自包含服务端 (含 node_modules、html-presets、dist、public)
  const resourcesServerDir = path.join(desktopDir, 'src-tauri', 'resources', 'server');
  const portableServerDir = path.join(portableDir, 'server');
  if (fs.existsSync(resourcesServerDir)) {
    console.log(`📦 正在镜像同步完整自包含服务资源 (含 node_modules 与 html-presets) 到 ${portableServerDir}...`);
    try {
      execSync(`robocopy "${resourcesServerDir}" "${portableServerDir}" /MIR /R:1 /W:1 /NJH /NJS /NFL /NDL`, { stdio: 'ignore' });
    } catch (e) {
      // robocopy 退出码 <= 7 均表示复制成功
    }
    console.log('✅ 自包含服务端资源镜像同步完成！');
  }

  // 5. 校验交付产物并输出
  const nsisDir = path.join(desktopDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  let setupExe = null;
  if (fs.existsSync(nsisDir)) {
    const files = fs.readdirSync(nsisDir)
      .filter(f => f.endsWith('.exe'))
      .map(name => {
        const fullPath = path.join(nsisDir, name);
        return { name, fullPath, stat: fs.statSync(fullPath) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length > 0) {
      setupExe = files[0].fullPath;
      // 同步复制最新安装包到根目录 dist-desktop 下，方便用户直接获取
      const targetDistInstaller = path.join(rootDir, 'dist-desktop', path.basename(setupExe));
      try {
        fs.copyFileSync(setupExe, targetDistInstaller);
        console.log(`✅ 已同步最新安装包至: ${targetDistInstaller}`);
      } catch (_) {}
    }
  }
  console.log('\n🎉 [Desktop Packager] 桌面端全量构建与同步成功！');
  if (setupExe && fs.existsSync(setupExe)) {
    const stat = fs.statSync(setupExe);
    console.log(`📦 NSIS 安装包: ${setupExe} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }
  if (fs.existsSync(targetPortableExe)) {
    const stat = fs.statSync(targetPortableExe);
    console.log(`💼 便携版可执行程序: ${targetPortableExe} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }
}

main().catch(err => {
  console.error('\n❌ [Desktop Packager] 构建失败:', err.message);
  process.exit(1);
});
