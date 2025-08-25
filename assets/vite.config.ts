import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
const port = Number(process.env.PORT || '3306');

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: port
  }
})
