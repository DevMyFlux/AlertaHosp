import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // gráficos (Recharts) ficam num arquivo próprio, carregado só quando uma página os usa
        manualChunks: id => (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') || id.includes('node_modules/victory-vendor') ? 'charts' : undefined),
      },
    },
  },
  server: { host: '0.0.0.0', port: 3000 },
});
