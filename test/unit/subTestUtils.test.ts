import * as assert from 'assert';
import { gnoTestRunPattern } from '../../src/subTestUtils';

suite('gnoTestRunPattern', () => {
	test('matches test functions by exact name', () => {
		assert.strictEqual(gnoTestRunPattern(['TestA', 'TestB']), '^(TestA|TestB)$');
	});

	test('matches a single filetest under the package directory', () => {
		assert.strictEqual(gnoTestRunPattern([], 'z1_filetest.gno'), '^\\.$/^z1_filetest\\.gno$');
	});

	test('runs everything without a selection', () => {
		assert.strictEqual(gnoTestRunPattern(), undefined);
	});
});
