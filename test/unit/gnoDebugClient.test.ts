import * as assert from 'assert';
import {
	commandError,
	localNames,
	parseLocation,
	parseStack,
	parseStop,
	parseValue
} from '../../src/debugAdapter/gnoDebugClient';

// Samples are verbatim outputs of `gno run -debug-addr`.
suite('gnoDebugClient parsers', () => {
	test('parseLocation drops the pkgpath of absolute files', () => {
		assert.deepStrictEqual(parseLocation('main//tmp/x/main.gno:6:7'), {
			file: '/tmp/x/main.gno',
			line: 6,
			column: 7
		});
		assert.strictEqual(parseLocation('gno.land/r/demo/foo//home/u/foo/foo.gno:1:2')?.file, '/home/u/foo/foo.gno');
		assert.strictEqual(parseLocation('strings/strings.gno:3:1')?.file, 'strings/strings.gno');
		assert.strictEqual(parseLocation('garbage'), undefined);
	});

	test('parseStop', () => {
		const out = '> main.add() main//tmp/x/main.gno:6:7\n  Realm: "main"\n=>    6: \tc := a + b\n';
		assert.deepStrictEqual(parseStop(out), {
			func: 'main.add',
			loc: { file: '/tmp/x/main.gno', line: 6, column: 7 }
		});
		assert.strictEqual(parseStop('> main main//tmp/x/main.gno:14:2\n')?.func, 'main');
		assert.strictEqual(parseStop('> main.add() main//tmp/my dir/main.gno:6:7\n')?.loc.file, '/tmp/my dir/main.gno');
		assert.strictEqual(parseStop('Welcome to the Gnovm debugger.\n'), undefined);
	});

	test('parseStack', () => {
		const out =
			'0\tin main.add\n\tat main//tmp/x/main.gno:6:7\n\tRealm: "main"\n' +
			'1\tin main.main\n\tat main//tmp/x/main.gno:13:2\n\tRealm: "main"\n';
		const frames = parseStack(out);
		assert.deepStrictEqual(
			frames.map((f) => [f.index, f.func, f.loc.line]),
			[
				[0, 'main.add', 6],
				[1, 'main.main', 13]
			]
		);
	});

	test('parseValue', () => {
		assert.deepStrictEqual(parseValue('(1 int)\n'), { value: '1', type: 'int' });
		assert.deepStrictEqual(parseValue('(struct{(2 int),(slice[("hi" string)] []string)} main.T)'), {
			value: 'struct{(2 int),(slice[("hi" string)] []string)}',
			type: 'main.T'
		});
		assert.deepStrictEqual(parseValue('(undefined)'), { value: 'undefined', type: '' });
		assert.strictEqual(parseValue('Command failed: name zz not declared\n'), undefined);
		assert.strictEqual(commandError('Command failed: name zz not declared\n'), 'name zz not declared');
		assert.strictEqual(commandError('(1 int)'), undefined);
	});

	test('localNames', () => {
		const lines = [
			'package main',
			'',
			'func (r *T) add(a, b int, s string) int {',
			'\tc := a + b',
			'\tvar d, e int',
			'\tfor i, v := range r.xs {',
			'\t\t_ = v',
			'\t}',
			'\treturn c',
			'}',
			'',
			'func main() {',
			'\tx := 1',
			'}'
		];
		assert.deepStrictEqual(localNames(lines, 9), ['r', 'a', 'b', 's', 'c', 'd', 'e', 'i', 'v']);
		// Names declared on or after the current line are not yet in scope.
		assert.deepStrictEqual(localNames(lines, 4), ['r', 'a', 'b', 's']);
		assert.deepStrictEqual(localNames(lines, 13), []);
		assert.deepStrictEqual(localNames(lines, 1), []);
	});
});
