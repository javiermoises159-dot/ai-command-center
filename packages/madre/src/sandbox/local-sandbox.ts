/**
 * Local sandbox.
 *
 * An isolated scratch area for temporary files, outputs, logs and artefacts.
 * It is a directory under the operating system's temp folder with hard limits
 * on size, count and depth, path-traversal protection, and cleanup.
 *
 * What it is NOT: it does not execute code. `exec` exists so the interface is
 * complete and always refuses. Running arbitrary code safely needs process or
 * container isolation this build does not have, and the tool registry keeps
 * `sandbox.exec` DISABLED for the same reason.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SandboxLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxDepth: number;
  maxLogEntries: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  maxFiles: 100,
  maxDepth: 6,
  maxLogEntries: 500,
};

export class SandboxError extends Error {
  constructor(
    readonly code: 'path_escape' | 'invalid_path' | 'limit_exceeded' | 'not_found' | 'exec_disabled' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxFile {
  path: string;
  bytes: number;
}

export interface SandboxUsage {
  files: number;
  bytes: number;
  limits: SandboxLimits;
}

export interface SandboxLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class LocalSandbox {
  private readonly logs: SandboxLogEntry[] = [];
  private closed = false;

  private constructor(
    readonly id: string,
    readonly root: string,
    private readonly limits: SandboxLimits,
    private readonly now: () => Date,
  ) {}

  /** Create a fresh sandbox under `baseDir` (default: the OS temp directory). */
  static async create(
    id: string,
    options: { baseDir?: string; limits?: Partial<SandboxLimits>; now?: () => Date } = {},
  ): Promise<LocalSandbox> {
    if (!SAFE_ID.test(id)) throw new SandboxError('invalid_path', `"${id}" no es un identificador de sandbox válido.`);
    const base = options.baseDir ?? path.join(tmpdir(), 'madre-sandbox');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, `${id}-`));
    return new LocalSandbox(id, root, { ...DEFAULT_SANDBOX_LIMITS, ...options.limits }, options.now ?? (() => new Date()));
  }

  /** Resolve a relative path inside the root, or refuse. */
  private resolve(relative: string): string {
    if (this.closed) throw new SandboxError('closed', 'El sandbox ya se ha limpiado.');
    if (typeof relative !== 'string' || relative.length === 0 || relative.length > 200 || relative.includes('\0')) {
      throw new SandboxError('invalid_path', 'La ruta está vacía, es demasiado larga o contiene un byte nulo.');
    }
    if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\')) {
      throw new SandboxError('path_escape', 'No se permiten rutas absolutas.');
    }
    const parts = relative.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
    if (parts.length === 0) throw new SandboxError('invalid_path', 'La ruta no nombra ningún archivo.');
    if (parts.includes('..')) throw new SandboxError('path_escape', 'La ruta sale del sandbox.');
    if (parts.length > this.limits.maxDepth) throw new SandboxError('limit_exceeded', `Las rutas pueden tener como máximo ${this.limits.maxDepth} ${this.limits.maxDepth === 1 ? 'nivel' : 'niveles'} de profundidad.`);
    const full = path.join(this.root, ...parts);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new SandboxError('path_escape', 'La ruta sale del sandbox.');
    return full;
  }

  private async walk(dir = this.root, prefix = ''): Promise<SandboxFile[]> {
    const out: SandboxFile[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await this.walk(path.join(dir, entry.name), rel)));
      else if (entry.isFile()) out.push({ path: rel, bytes: (await fs.stat(path.join(dir, entry.name))).size });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async write(relative: string, content: string): Promise<SandboxFile> {
    const full = this.resolve(relative);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.limits.maxFileBytes) throw new SandboxError('limit_exceeded', `Un archivo puede ocupar como máximo ${this.limits.maxFileBytes} bytes.`);

    const existing = await this.walk();
    const rel = path.relative(this.root, full).split(path.sep).join('/');
    const others = existing.filter((f) => f.path !== rel);
    if (others.length + 1 > this.limits.maxFiles) throw new SandboxError('limit_exceeded', `El sandbox admite como máximo ${this.limits.maxFiles} ${this.limits.maxFiles === 1 ? 'archivo' : 'archivos'}.`);
    if (others.reduce((n, f) => n + f.bytes, 0) + bytes > this.limits.maxTotalBytes) {
      throw new SandboxError('limit_exceeded', `El sandbox admite como máximo ${this.limits.maxTotalBytes} bytes en total.`);
    }

    await fs.mkdir(path.dirname(full), { recursive: true });
    // Refuse to write through a symlink that could point outside the root.
    try {
      if ((await fs.lstat(full)).isSymbolicLink()) throw new SandboxError('path_escape', 'No se permiten enlaces simbólicos.');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    await fs.writeFile(full, content, { encoding: 'utf8', flag: 'w' });
    this.log('info', `wrote ${rel} (${bytes} bytes)`);
    return { path: rel, bytes };
  }

  async read(relative: string): Promise<string> {
    const full = this.resolve(relative);
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new SandboxError('path_escape', 'No se permiten enlaces simbólicos.');
      if (!stat.isFile()) throw new SandboxError('not_found', `${relative} no es un archivo.`);
      return await fs.readFile(full, 'utf8');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError('not_found', `${relative} no existe.`);
    }
  }

  async list(): Promise<SandboxFile[]> {
    if (this.closed) throw new SandboxError('closed', 'El sandbox ya se ha limpiado.');
    return this.walk();
  }

  /** Files under `outputs/` are the sandbox's deliverables. */
  async artifacts(): Promise<SandboxFile[]> {
    return (await this.list()).filter((f) => f.path.startsWith('outputs/'));
  }

  async usage(): Promise<SandboxUsage> {
    const files = await this.list();
    return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), limits: this.limits };
  }

  log(level: SandboxLogEntry['level'], message: string): void {
    this.logs.push({ at: this.now().toISOString(), level, message });
    if (this.logs.length > this.limits.maxLogEntries) this.logs.splice(0, this.logs.length - this.limits.maxLogEntries);
  }

  logEntries(): readonly SandboxLogEntry[] {
    return this.logs;
  }

  /** Always refuses. See the module note. */
  exec(_command: string): never {
    throw new SandboxError('exec_disabled', 'La ejecución de código está desactivada: necesita un aislamiento por proceso o contenedor del que esta versión no dispone.');
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
