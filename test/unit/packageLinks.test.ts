import * as assert from 'assert';
import { packageSourceLink, packageSourceLinksInMarkdown } from '../../src/language/packageLinks';

suite('package source links', () => {
	test('maps direct and gnopls package URLs to the selected gnoweb', () => {
		for (const link of [
			'https://gno.land/r/gnoland/coins',
			'https://gno.land/gno.land/r/gnoland/coins',
			'https://pkg.go.dev/gno.land/r/gnoland/coins',
			'https://godoc.org/gno.land/r/gnoland/coins'
		]) {
			assert.strictEqual(
				packageSourceLink(link, 'http://127.0.0.1:8888/'),
				'http://127.0.0.1:8888/r/gnoland/coins$source'
			);
		}
		assert.strictEqual(
			packageSourceLink(
				'https://docs.example/gno.land/p/demo/avl#Tree',
				'https://test.example/gno/',
				'docs.example'
			),
			'https://test.example/gno/p/demo/avl$source#Tree'
		);
	});

	test('falls back to gno.land and does not duplicate the source suffix', () => {
		assert.strictEqual(
			packageSourceLink('https://gno.land/p/demo/avl$source#Tree'),
			'https://gno.land/p/demo/avl$source#Tree'
		);
		assert.strictEqual(
			packageSourceLink('https://pkg.go.dev/gno.land/r/gnoland/coins'),
			'https://gno.land/r/gnoland/coins$source'
		);
	});

	test('leaves unrelated links and invalid URLs alone', () => {
		for (const link of [
			'https://gno.land/std',
			'https://pkg.go.dev/fmt#Println',
			'https://pkg.go.dev/r/demo/foo',
			'https://example.com/gno.land/r/demo/foo',
			'https://gno.land.example/r/demo/foo',
			'file:///gno.land/r/demo/foo',
			'not a URL'
		]) {
			assert.strictEqual(packageSourceLink(link), link);
		}
		const link = 'https://gno.land/r/demo/foo';
		assert.strictEqual(packageSourceLink(link, 'not a URL'), link);
		assert.strictEqual(packageSourceLink(link, 'javascript:alert(1)'), link);
	});

	test('rewrites hover destinations while preserving labels and other documentation', () => {
		const markdown = [
			'[coins](https://pkg.go.dev/gno.land/r/gnoland/coins#Balance)',
			'<https://gno.land/p/demo/avl>',
			'[fmt](https://pkg.go.dev/fmt)',
			'`https://gno.land/r/demo/foo`'
		].join('\n');
		assert.strictEqual(
			packageSourceLinksInMarkdown(markdown, 'http://localhost:8888'),
			[
				'[coins](http://localhost:8888/r/gnoland/coins$source#Balance)',
				'<http://localhost:8888/p/demo/avl$source>',
				'[fmt](https://pkg.go.dev/fmt)',
				'`https://gno.land/r/demo/foo`'
			].join('\n')
		);
	});
});
