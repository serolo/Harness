import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPackageDir = dirname(
  fileURLToPath(import.meta.resolve('electron/package.json')),
);
const sourceApp = join(electronPackageDir, 'dist', 'Electron.app');
const runtimeDir = join(projectDir, '.electron-dev');
const runtimeApp = join(runtimeDir, 'Harness.app');
const runtimeExecutable = join(
  runtimeApp,
  'Contents',
  'MacOS',
  'Electron',
);
const sourceVersion = JSON.parse(
  readFileSync(join(electronPackageDir, 'package.json'), 'utf8'),
).version;
const versionFile = join(runtimeDir, 'electron-version');

function checked(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function prepareMacRuntime() {
  const cachedVersion = existsSync(versionFile)
    ? readFileSync(versionFile, 'utf8').trim()
    : undefined;

  if (cachedVersion === sourceVersion && existsSync(runtimeExecutable)) {
    return runtimeExecutable;
  }

  rmSync(runtimeApp, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  // ditto preserves the framework symlinks and bundle structure required by
  // macOS code signing; fs.cpSync expands some framework links on macOS.
  checked('/usr/bin/ditto', [sourceApp, runtimeApp]);

  const plist = join(runtimeApp, 'Contents', 'Info.plist');
  checked('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleName Harness',
    plist,
  ]);
  checked('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleDisplayName Harness',
    plist,
  ]);
  checked('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleIdentifier com.serolo.harness.dev',
    plist,
  ]);

  // Modifying Info.plist invalidates Electron's bundled signature. An ad-hoc
  // signature keeps the branded development runtime launchable on macOS.
  checked('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    runtimeApp,
  ]);
  writeFileSync(versionFile, `${sourceVersion}\n`);
  return runtimeExecutable;
}

const electronExecPath =
  process.platform === 'darwin' ? prepareMacRuntime() : undefined;
const cli = join(
  projectDir,
  'node_modules',
  'electron-vite',
  'bin',
  'electron-vite.js',
);
const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
  cwd: projectDir,
  env: {
    ...process.env,
    ...(electronExecPath === undefined
      ? {}
      : { ELECTRON_EXEC_PATH: electronExecPath }),
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
