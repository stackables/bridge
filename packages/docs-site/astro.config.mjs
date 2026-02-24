// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightCatppuccin from '@catppuccin/starlight'
import bridgeGrammar from '../bridge-syntax-highlight/syntaxes/bridge.tmLanguage.json' assert { type: 'json' };
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				'@': fileURLToPath(new URL('../playground/src', import.meta.url)),
				'@stackables/bridge': fileURLToPath(new URL('../bridge/src/index.ts', import.meta.url)),
			},
		},
	},
	integrations: [
		starlight({
			title: 'The Bridge',
			logo: {
        src: './src/assets/logo.svg',
      },

			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/stackables/bridge' },
				{ icon: 'npm', label: 'NPM', href: 'https://www.npmjs.com/package/@stackables/bridge' }
			],
			expressiveCode: {
				shiki: {
					langs: [
						// @ts-expect-error imported as plain json
						bridgeGrammar
					],
				},
			},
			sidebar: [
				{
					label: 'Guides',
					items: [
						// Each item here is one entry in the navigation menu.
						{ label: 'Getting Started', slug: 'guides/getting-started' },
					],
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
			plugins: [starlightCatppuccin({
				light: {
					flavor: "latte",
					accent: 'blue'
				},
				dark: {
					flavor: "mocha",
					accent: 'blue'
				},
			})],
		}),
		react(),
	],
});
