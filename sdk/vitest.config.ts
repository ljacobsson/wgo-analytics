import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    // tests create <link>, <iframe> and <script src> elements (session recording); don't fetch what they point at
    environmentOptions: { happyDOM: { settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true } } },
  },
})
