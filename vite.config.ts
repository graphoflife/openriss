import { defineConfig } from 'vite';

// "base: './'" sorgt dafür, dass der Build unter jedem GitHub-Pages-Unterpfad läuft.
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
