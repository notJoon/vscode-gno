import * as assert from 'assert';
import { packagePath, renderUrlPath } from '../../src/gnodev/render';

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

	test('package path below the module', () => {
		assert.strictEqual(packagePath('gno.land/r/demo/foo', ''), 'gno.land/r/demo/foo');
		assert.strictEqual(packagePath('gno.land/r/demo/foo', 'sub'), 'gno.land/r/demo/foo/sub');
		assert.strictEqual(packagePath('gno.land/r/demo/foo', 'a/b'), 'gno.land/r/demo/foo/a/b');
		assert.strictEqual(packagePath('gno.land/r/demo/foo', 'a\\b'), 'gno.land/r/demo/foo/a/b');
	});
});
