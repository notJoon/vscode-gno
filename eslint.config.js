module.exports = [
	{ ignores: ['build/', 'node_modules/', 'out/', 'dist/', 'third_party/'] },
	...require('gts'),
	{
		rules: {
			// Unused parameters keep signatures of callbacks and ports from the Go extension readable.
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }]
		}
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
			'n/no-unpublished-require': 'off'
		}
	}
];
