import { execFileSync } from 'node:child_process';
import { platform as osPlatform, userInfo } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

const SHELL_ENV_DELIMITER = '_SHELL_ENV_DELIMITER_';

// the command builtin avoids a shell alias or function named env
const SHELL_ARGS = ['-ilc', `echo -n "${SHELL_ENV_DELIMITER}"; command env; echo -n "${SHELL_ENV_DELIMITER}"; exit`];

const SHELL_ENV = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

// an interactive shell can ignore SIGTERM and wait for input forever, which would
// freeze the whole process on every npm lookup
const SHELL_TIMEOUT_MS = 10_000;

const FALLBACK_PATH = ['./node_modules/.bin', '/.nodebrew/current/bin', '/usr/local/bin'];

let shellsTimedOut = false;

export type ShellEnvResult = { env: Record<string, string> } | { timedOut: boolean };

export function detectDefaultShell(): string {
  try {
    const { shell } = userInfo();
    if (shell) {
      return shell;
    }
  } catch {
    //
  }

  if (process.env.SHELL) {
    return process.env.SHELL;
  }

  return osPlatform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

export function shellEnv(shell: string): ShellEnvResult {
  try {
    const stdout = execFileSync(shell, SHELL_ARGS, {
      env: { ...process.env, ...SHELL_ENV },
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const printed = stdout.split(SHELL_ENV_DELIMITER)[1];
    if (printed === undefined) {
      return { timedOut: false };
    }

    const env: Record<string, string> = {};
    for (const line of stripVTControlCharacters(printed).split('\n').filter(Boolean)) {
      const [key, ...values] = line.split('=');
      env[key] = values.join('=');
    }

    return { env };
  } catch (error) {
    return { timedOut: (error as { signal?: string }).signal === 'SIGKILL' };
  }
}

export function shellPath(): string | undefined {
  const defaultShell = detectDefaultShell();
  const shells = [defaultShell, ...['/bin/zsh', '/bin/bash'].filter((shell) => shell !== defaultShell)];

  let timeouts = 0;

  for (const shell of shells) {
    const result = shellEnv(shell);

    if ('env' in result) {
      return result.env.PATH;
    }

    if (result.timedOut) {
      timeouts++;
    }
  }

  // every shell hung: stop probing, or the next call waits again
  if (timeouts === shells.length) {
    shellsTimedOut = true;
  }

  return process.env.PATH;
}

export function fixPath(): void {
  if (osPlatform() === 'win32' || shellsTimedOut) {
    return;
  }

  const fromShell = shellPath();
  const stripped = fromShell ? stripVTControlCharacters(fromShell) : '';

  process.env.PATH = stripped || [...FALLBACK_PATH, process.env.PATH].join(':');
}

export function resetShellProbe(): void {
  shellsTimedOut = false;
}
