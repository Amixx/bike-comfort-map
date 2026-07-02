import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Relative assets make the build work from any GitHub Pages project path.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  build: {
    outDir: 'docs',
  },
})
