import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: { include: ['src/tests/ui/**/*.ui-test.ts'], environment: 'happy-dom' },
});
