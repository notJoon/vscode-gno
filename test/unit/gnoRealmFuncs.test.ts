import * as assert from 'assert';
import { crossingFuncs, gnokeyError } from '../../src/gnoRealmFuncs';

suite('realm crossing functions', () => {
	test('finds exported crossing functions with their params', () => {
		const src = [
			'package counter',
			'func Incr(cur realm) int { return 0 }',
			'func Add(_ realm, a, b int, name string) {}',
			'func Multi(',
			'\tcur realm,',
			'\tn int,',
			') {}',
			'func private(cur realm) {}',
			'func NotCrossing(n int) {}',
			'func (s *T) Method(cur realm) {}'
		].join('\n');
		assert.deepStrictEqual(
			crossingFuncs(src).map((f) => [f.name, f.params]),
			[
				['Incr', []],
				[
					'Add',
					[
						{ name: 'a', type: 'int' },
						{ name: 'b', type: 'int' },
						{ name: 'name', type: 'string' }
					]
				],
				['Multi', [{ name: 'n', type: 'int' }]]
			]
		);
		assert.strictEqual(crossingFuncs(src)[0].offset, src.indexOf('func Incr'));
	});

	test('gnokey errors', () => {
		const tx = [
			'Enter password.',
			'--= Error =--',
			'Data: internal error',
			'Msg Traces:',
			'    0  github.com/gnolang/gno/tm2/pkg/errors/errors.go:103 - deliver transaction failed: log:recovered: bad int',
			'stack:',
			'--= /Error =--'
		].join('\n');
		assert.strictEqual(gnokeyError(tx), 'deliver transaction failed: log:recovered: bad int');
		assert.strictEqual(
			gnokeyError('pkg:0:0: name Nope not declared:\n--- preprocess stack ---'),
			'pkg:0:0: name Nope not declared:'
		);
		const nested = [
			'--= Error =--',
			'Msg Traces:',
			'    0  github.com/gnolang/gno/tm2/pkg/errors/errors.go:103 - deliver transaction failed: log:--= Error =--',
			'Msg Traces:',
			'    0  gno/gno.land/pkg/sdk/vm/errors.go:80 - package already exists: gno.land/r/demo/foo',
			'Stack Trace:',
			'    0  gno/tm2/pkg/errors/errors.go:93'
		].join('\n');
		assert.strictEqual(gnokeyError(nested), 'package already exists: gno.land/r/demo/foo');
		assert.strictEqual(gnokeyError('Enter password.\n'), undefined);
	});
});
