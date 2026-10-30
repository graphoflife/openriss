// Laufzeitumgebung: Browser (mit DOM) oder headless (Node, Skripte, CLI).
export const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
/** globales Objekt (window im Browser, globalThis in Node) */
export const glob: any = typeof window !== 'undefined' ? window : globalThis;
/** sicherer localStorage-Zugriff (headless: Speicher im Arbeitsspeicher) */
const mem = new Map<string, string>();
export const store = {
  get(k: string): string | null { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : mem.get(k) ?? null; } catch { return mem.get(k) ?? null; } },
  set(k: string, v: string): void { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); else mem.set(k, v); } catch { mem.set(k, v); } },
  remove(k: string): void { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); else mem.delete(k); } catch { mem.delete(k); } },
};
