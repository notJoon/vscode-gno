import * as assert from 'assert';
import { renderUrlPath } from '../../src/gnodev/render';

suite('gnodev render', () => {
	test('realm home', () => {
		assert.strictEqual(renderUrlPath('gno.land/r/demo/foo', ''), '/r/demo/foo');
	});

	test('render path', () => {
		assert.strictEqual(renderUrlPath('gno.land/r/demo/foo', 'bar/baz?x=1'), '/r/demo/foo:bar/baz?x=1');
		assert.strictEqual(renderUrlPath('gno.land/r/demo/foo', 'a b'), '/r/demo/foo:a%20b');
	});

	test('not a realm', () => {
		assert.strictEqual(renderUrlPath('gno.land/p/demo/avl', ''), undefined);
		assert.strictEqual(renderUrlPath('r/demo/foo', ''), undefined);
	});
});
