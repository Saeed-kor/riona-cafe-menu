import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendDevelopmentTarget = 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '^/api(?:/|\\?|$)': {
        target: backendDevelopmentTarget,
        changeOrigin: true,
      },
      '^/uploads(?:/|\\?|$)': {
        target: backendDevelopmentTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {},
  },
})
