import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';

export default defineConfig(({ command }) => {
  const plugins = [react()];

  if (command === 'serve') {
    plugins.push(
      checker({
        typescript: true,
      }),
    );
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react')) {
              return 'vendor-react';
            }
            if (id.includes('node_modules/radix-ui')) {
              return 'vendor-radix';
            }
            if (id.includes('node_modules/echarts')) {
              return 'vendor-echarts';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:8000',
        '^/metrics(/|$)': 'http://127.0.0.1:8000',
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
    },
  };
});
