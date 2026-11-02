import type { LookFactory } from './types';

/** Every module in ./library default-exports one look (discovered at build time). */
const modules = import.meta.glob<{ default: LookFactory }>('./library/*.ts', { eager: true });

export const LOOKS: LookFactory[] = Object.values(modules)
  .map((m) => m.default)
  .filter((f): f is LookFactory => !!f?.meta)
  .sort((a, b) => a.meta.id.localeCompare(b.meta.id));
