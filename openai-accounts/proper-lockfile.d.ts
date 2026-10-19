declare module "proper-lockfile" {
  interface LockOptions {
    fs?: Record<string, unknown>;
    realpath?: boolean;
    stale?: number;
    update?: number;
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };
    onCompromised?: (error: Error) => void;
  }
  const lockfile: {
    lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;
    lockSync(path: string, options?: LockOptions): () => void;
  };
  export default lockfile;
}
