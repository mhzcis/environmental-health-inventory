import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    base: process.env.VITE_BASE_PATH || './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      dedupe: ['react', 'react-dom'],
    },
    build: {
      chunkSizeWarningLimit: 10000,
      target: 'es2015',
      rollupOptions: {
        input: { main: path.resolve(__dirname, 'index.html'), recovery: path.resolve(__dirname, 'reset-password.html') },
        output: {}
      }
    },
    server: {
      allowedHosts: true as const,
      hmr: process.env.DISABLE_HMR === 'true' ? false : { overlay: false },
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
