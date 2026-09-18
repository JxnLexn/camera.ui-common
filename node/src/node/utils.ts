import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { fixPath } from './fix-path.js';

function isModuleRootDirectory(dir: string): boolean {
  const packageJsonPath = join(dir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return isExpectedPackage(packageJson, dir);
  } catch {
    return false;
  }
}

function isExpectedPackage(packageJson: any, dir: string): boolean {
  const dirName = basename(dir);
  const parentDirName = basename(dirname(dir));

  if (parentDirName.startsWith('@')) {
    return packageJson.name === `${parentDirName}/${dirName}`;
  } else {
    return packageJson.name === dirName;
  }
}

export function getNpmPath(): string[] {
  fixPath();

  if (osPlatform() === 'win32') {
    // if running on windows find the full path to npm
    const windowsNpmPath = [
      join(process.env.APPDATA!, 'npm/npm.cmd'),
      join(process.env.ProgramFiles!, 'nodejs/npm.cmd'),
      join(process.env.NVM_SYMLINK ?? process.env.ProgramFiles + '/nodejs', 'npm.cmd'),
    ].filter(existsSync);

    if (windowsNpmPath.length) {
      return [windowsNpmPath[0]];
    }
  } else {
    try {
      const npmPath = execSync('which npm').toString().trim();

      if (npmPath) {
        return [npmPath];
      }
    } catch {
      //
    }

    if (existsSync('/opt/homebridge/bin/npm')) {
      return ['/opt/homebridge/bin/npm'];
    }
  }

  return ['npm'];
}

export function getNpmGlobalModulesDirectory(): string {
  const npmPath = getNpmPath().join(' ');
  const isWindows = osPlatform() === 'win32';
  const isSudo = !isWindows && process.getuid?.() === 0;

  const npmEnv = Object.assign(
    {
      npm_config_loglevel: 'silent',
      npm_update_notifier: 'false',
    },
    process.env,
  );

  if (isWindows) {
    const npmPrefix = execSync(`"${npmPath}" -g prefix`, {
      encoding: 'utf8',
      env: npmEnv,
    }).trim();

    return join(npmPrefix, 'node_modules');
  } else {
    const npmPrefix = execSync(`${isSudo ? 'sudo ' : ''}${npmPath} -g prefix`, {
      encoding: 'utf8',
      env: npmEnv,
    }).trim();

    return join(npmPrefix, 'lib', 'node_modules');
  }
}

export function getInstallDir(currentDir: string, moduleName: string): string {
  const rootDir = dirname(currentDir) === currentDir ? currentDir : sep;

  while (currentDir !== rootDir) {
    if (isModuleRootDirectory(currentDir)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  const npmPrefix = getNpmGlobalModulesDirectory();
  return join(npmPrefix, moduleName);
}

export function getUserHomeDir(asUser?: string): string {
  const isWindows = osPlatform() === 'win32';
  const user = asUser ?? process.env.SUDO_USER ?? process.env.USER;

  if (isWindows) {
    return process.env.USERPROFILE ?? homedir();
  }

  try {
    if (process.getuid?.() === 0) {
      if (user) {
        const homeDir = execSync(`eval echo ~${user}`, { encoding: 'utf8' }).trim();
        if (homeDir.startsWith('~')) {
          throw new Error('Could not resolve user home directory');
        }

        return homeDir;
      }
    } else {
      return process.env.HOME ?? homedir();
    }
  } catch {
    // Fallback
  }

  // Fallback
  return homedir();
}

export function isProcessRunning(pid: number): boolean {
  try {
    const platform = osPlatform();

    if (platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toString();
      return output.toLowerCase().includes(pid.toString());
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (error) {
    if (error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}
