import { Platform } from 'obsidian';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ExecException extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/** Cache of the resolved binary path. null = attempted and not found. undefined = not yet attempted. */
let resolvedBinary: string | null | undefined;

/**
 * Tracks whether the Windows named pipe between Obsidian.com and the Obsidian
 * main process has been initialized this session.
 *
 * Obsidian.com is a console-subsystem binary that communicates with the running
 * Obsidian instance via \\.\pipe\obsidian-cli-{username}. When spawned from the
 * Electron renderer (GUI process — no console), its first IPC command silently
 * fails because the console-less environment prevents the named-pipe handshake.
 *
 * After one successful pipe-capable call (from a process WITH a console), the
 * pipe connection is cached in the Obsidian main process and all subsequent
 * calls — even from console-less processes — reuse it.
 *
 * We run a one-time warm-up command with windowsHide: false (which allocates a
 * visible console window for the child) to establish the pipe. Once
 * pipeInitialized is true, all calls use windowsHide: true (no window flash).
 */
let pipeInitialized = false;

/**
 * On non-Windows platforms the named-pipe issue does not exist. We detect this
 * once and skip the warm-up entirely.
 */
let isWindows: boolean | undefined;

const WRITE_PREFIXES = [
  'create', 'delete', 'move', 'rename', 'append', 'prepend',
  'daily:append', 'daily:prepend',
  'plugin:install', 'plugin:uninstall',
  'property:set', 'property:remove',
  'publish:add', 'publish:remove',
  'sync:restore',
  'theme:install', 'theme:uninstall', 'theme:set',
  'snippet:enable', 'snippet:disable',
];

export function isWriteCliCommand(command: string): boolean {
  const trimmed = command.trim();
  return WRITE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface ExecProxy {
  exec: (command: string, options: Record<string, unknown>, callback: (err: ExecException | null, stdout: string, stderr: string) => void) => {
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
  };
}

async function loadExec(): Promise<ExecProxy | null> {
  if (!Platform.isDesktop) return null;
  try {
    const cp = await import('child_process');
    return cp;
  } catch {
    return null;
  }
}

/**
 * Promisified wrapper around child_process.exec.
 * When encoding is 'utf-8' (as we always pass), stdout and stderr are strings.
 * On error, the rejection includes attached stdout/stderr properties.
 */
async function execAsync(command: string, options: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<{stdout: string; stderr: string}> {
  const cp = await loadExec();
  if (!cp) {
    throw new Error('child_process not available');
  }
  return new Promise((resolve, reject) => {
    const child = cp.exec(command, options, (err: ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });

    if (onProgress) {
      if (child.stdout) {
        child.stdout.on('data', (data: unknown) => onProgress(String(data)));
      }
      if (child.stderr) {
        child.stderr.on('data', (data: unknown) => onProgress(String(data)));
      }
    }
  });
}

function binaryName(): string {
  return process.platform === 'win32' ? 'Obsidian.com' : 'obsidian';
}

function knownInstallPaths(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      localAppData ? `${localAppData}\\Programs\\Obsidian\\Obsidian.com` : '',
      localAppData ? `${localAppData}\\Obsidian\\Obsidian.com` : '',
      `${progFiles}\\Obsidian\\Obsidian.com`,
      `${progFilesX86}\\Obsidian\\Obsidian.com`,
    ].filter(Boolean);
  }

  if (process.platform === 'darwin') {
    return [
      '/usr/local/bin/obsidian',
      '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',
    ];
  }

  if (process.platform === 'linux') {
    const home = process.env.HOME || '';
    return [
      home ? `${home}/.local/bin/obsidian` : '',
      '/snap/bin/obsidian',
      '/opt/Obsidian/obsidian-cli',
      '/usr/bin/obsidian',
    ].filter(Boolean);
  }

  return [];
}

/**
 * Test whether a candidate binary path works by running `<binary> version`.
 * If the binary doesn't exist, the exec call throws ENOENT and we return false.
 */
async function verifyBinary(binaryPath: string): Promise<boolean> {
  if (!binaryPath) return false;
  try {
    const { stdout } = await execAsync(`"${binaryPath}" version`, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
    
    return true;
  } catch (error: unknown) {
    
    return false;
  }
}

async function findBinaryInPaths(): Promise<string | null> {
  const whichCommands = process.platform === 'win32'
    ? [`where ${binaryName()}`, 'where obsidian']
    : ['which obsidian'];

  for (const cmd of whichCommands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
      if (stdout) {
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        if (lines.length > 0) {
          
          return lines[0];
        }
      }
    } catch {
      continue;
    }
  }

  for (const candidate of knownInstallPaths()) {
    if (await verifyBinary(candidate)) {
      
      return candidate;
    }
  }

  
  return null;
}

async function locateBinary(explicitPath?: string, force?: boolean): Promise<string | null> {
  

  if (resolvedBinary !== undefined && !explicitPath && !force) return resolvedBinary;

  if (explicitPath) {
    if (await verifyBinary(explicitPath)) {
      resolvedBinary = explicitPath;
      return resolvedBinary;
    }
    
    return null;
  }

  resolvedBinary = await findBinaryInPaths();
  return resolvedBinary;
}

export async function detectBinaryPath(): Promise<string | null> {
  return locateBinary(undefined, true);
}

export function clearBinaryCache(): void {
  resolvedBinary = undefined;
}

/**
 * Runs a one-time warm-up command to establish the Windows named pipe between
 * Obsidian.com and the running Obsidian instance.
 *
 * The warm-up runs `vault` (fast, read-only, no side-effects) with
 * windowsHide: false so the child process gets a visible console window.
 * Obsidian.com needs this console to perform the named-pipe handshake with the
 * Obsidian main process. Once the pipe is connected, subsequent calls — even
 * from the console-less Electron renderer — reuse the established connection.
 *
 * On non-Windows platforms the warm-up is a no-op because the pipe
 * initialization issue does not occur (the native binary handles it natively).
 */
async function ensurePipeInitialized(binary: string): Promise<void> {
  if (isWindows === undefined) {
    isWindows = process.platform === 'win32';
  }

  if (pipeInitialized || !isWindows) return;

  try {
    
    await execAsync(`"${binary}" vault`, {
      timeout: 10000,
      encoding: 'utf-8',
      windowsHide: false,
    });
  } catch (error: unknown) {
    // The warm-up is best-effort: a failure here only means the pipe may be
    // established lazily on a later retry with a visible console window.
  } finally {
    pipeInitialized = true;
  }
}

/**
 * Determine whether a failed CliResult warrants a retry with a visible console
 * window. We retry when the failure pattern matches a "pipe not initialized"
 * scenario: no stdout content AND a non-zero exit that isn't a file-not-found
 * or user-requested abort.
 */
function shouldRetryForPipeInit(result: CliResult): boolean {
  if (isWindows === undefined) {
    isWindows = process.platform === 'win32';
  }
  if (!isWindows) return false;

  const hasStdout = result.stdout && result.stdout.length > 0;
  const isPipeFailure = !hasStdout && (
    result.exitCode === 1 ||
    result.exitCode === -1 ||
    result.exitCode === -3
  );

  return isPipeFailure;
}

/**
 * Execute a CLI command and return the result.
 * Always returns a CliResult — never throws. All errors (non-zero exit,
 * timeouts, ENOENT) are captured in the returned CliResult with an
 * appropriate exitCode.
 *
 * On Windows, performs an automatic one-time named-pipe warm-up before the
 * first command. If the command fails with no stdout and a suspicious exit
 * code, it is retried once with a visible console window to establish the
 * pipe connection.
 */
export async function executeCliCommand(command: string, timeoutMs = 60000, explicitPath?: string, onProgress?: (chunk: string) => void): Promise<CliResult> {
  const binary = await locateBinary(explicitPath);
  

  if (!binary) {
    return {
      stdout: '',
      stderr: 'Obsidian CLI binary not found. Use the "Detect" button in Agent settings to find it, or set the path manually.',
      exitCode: -1,
    };
  }

  // Ensure the named pipe is warm (first call only, Windows only)
  await ensurePipeInitialized(binary);

  const fullCommand = `"${binary}" ${command}`;
  

  const execOptions = {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf-8' as const,
    windowsHide: true,
  };

  try {
    const { stdout, stderr } = await execAsync(fullCommand, execOptions, onProgress);
    
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const execErr = error as ExecException & {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
    };

    const errStdout = execErr.stdout || '';
    const errStderr = execErr.stderr || '';

    let exitCode: number | null;
    if (typeof execErr.code === 'number') {
      exitCode = execErr.code;
    } else if (execErr.code === 'ENOENT') {
      exitCode = -2;
    } else if (execErr.code === 'ETIMEOUT' || execErr.killed) {
      exitCode = -3;
    } else {
      exitCode = -1;
    }

    const firstResult: CliResult = {
      stdout: errStdout,
      stderr: errStderr || execErr.message || 'CLI command failed',
      exitCode,
    };

    
    

    // Retry once with a visible console window if the failure looks like
    // the pipe was not yet established.
    if (shouldRetryForPipeInit(firstResult)) {
      
      try {
        const { stdout: retryStdout, stderr: retryStderr } = await execAsync(fullCommand, {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf-8',
          windowsHide: false,
        }, onProgress);
        
        pipeInitialized = true;
        return { stdout: retryStdout, stderr: retryStderr, exitCode: 0 };
      } catch (retryError: unknown) {
        const retryExecErr = retryError as ExecException & {
          stderr?: string;
          stdout?: string;
        };
        const retryStdout = retryExecErr.stdout || '';
        const retryStderr = retryExecErr.stderr || '';
        
        return {
          stdout: retryStdout,
          stderr: retryStderr || retryExecErr.message || 'CLI command failed after retry',
          exitCode: typeof retryExecErr.code === 'number' ? retryExecErr.code : -1,
        };
      }
    }

    return firstResult;
  }
}
