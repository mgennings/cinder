import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode across the project, except for libraries. Removable in Svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Static SPA: any /n/<id> URL falls back to the shell and resolves client-side.
			adapter: adapter({ fallback: '200.html' })
		})
	],
	test: {
		environment: 'jsdom',
		include: ['src/**/*.test.ts']
	}
});
