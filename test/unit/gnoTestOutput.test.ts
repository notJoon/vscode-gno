import * as assert from 'assert';
import { GnoTestEvent, GnoTestOutputParser } from '../../src/gnoTest/gnoTestOutput';

function parse(output: string): GnoTestEvent[] {
	const p = new GnoTestOutputParser();
	return [...output.split('\n').flatMap((l) => p.line(l)), ...p.done()];
}

function summary(events: GnoTestEvent[]): string[] {
	return events.filter((e) => e.Action !== 'output').map((e) => `${e.Action} ${e.Test}`);
}

function outputOf(events: GnoTestEvent[], test: string): string {
	return events
		.filter((e) => e.Action === 'output' && e.Test === test)
		.map((e) => e.Output)
		.join('');
}

// A sample of `gno test -v` (gno v1.7.0), trimmed.
const sample = `Running tool: gno test -v .

=== RUN   TestPass
logged
--- PASS: TestPass (0.00s)
--- GAS:  1234
=== RUN   TestFail
want 2
--- FAIL: TestFail (0.01s)
=== RUN   TestSkip
nope
--- SKIP: TestSkip (0.00s)
=== RUN   TestSub
=== RUN   TestSub/ok
--- PASS: TestSub/ok (0.00s)
=== RUN   TestSub/bad
sub failed
--- FAIL: TestSub/bad (0.00s)
--- FAIL: TestSub (0.00s)
=== RUN   ./z1_filetest.gno
--- PASS: ./z1_filetest.gno (elapsed: 0.00s, gas: 7331)
=== RUN   ./z2_filetest.gno
--- FAIL: ./z2_filetest.gno (elapsed: 0.02s, gas: 7331)
Output diff:
--- Expected
+++ Actual
-3
+2

failed: "TestFail"; ./z2_filetest.gno failed
FAIL    . 	0.37s
FAIL
FAIL: 0 build errors, 1 test errors`;

suite('GnoTestOutputParser', () => {
	const events = parse(sample);

	test('reports the start and the result of every test', () => {
		assert.deepStrictEqual(summary(events), [
			'run TestPass',
			'pass TestPass',
			'run TestFail',
			'fail TestFail',
			'run TestSkip',
			'skip TestSkip',
			'run TestSub',
			'run TestSub/ok',
			'pass TestSub/ok',
			'run TestSub/bad',
			'fail TestSub/bad',
			'fail TestSub',
			'run z1_filetest.gno',
			'pass z1_filetest.gno',
			'run z2_filetest.gno',
			'fail z2_filetest.gno'
		]);
	});

	test('keeps the output of a test, including the details after a filetest FAIL', () => {
		assert.strictEqual(outputOf(events, 'TestFail'), 'want 2\n');
		assert.strictEqual(outputOf(events, 'TestSub/bad'), 'sub failed\n');
		assert.strictEqual(outputOf(events, 'z2_filetest.gno'), 'Output diff:\n--- Expected\n+++ Actual\n-3\n+2\n\n');
	});

	test('reads the elapsed time of tests and filetests', () => {
		assert.strictEqual(events.find((e) => e.Action === 'fail' && e.Test === 'TestFail')?.Elapsed, 0.01);
		assert.strictEqual(events.find((e) => e.Action === 'fail' && e.Test === 'z2_filetest.gno')?.Elapsed, 0.02);
	});

	test('ends the output of a failed filetest at the summary of the package', () => {
		const e = parse(
			'=== RUN   ./a_filetest.gno\n--- FAIL: ./a_filetest.gno (elapsed: 0.00s)\ndiff\n./a_filetest.gno failed\nFAIL    . \t0.1s'
		);
		assert.strictEqual(outputOf(e, 'a_filetest.gno'), 'diff\n');
	});

	test('holds a fail event back until the end of the output', () => {
		const p = new GnoTestOutputParser();
		assert.deepStrictEqual(p.line('=== RUN   ./a_filetest.gno'), [{ Action: 'run', Test: 'a_filetest.gno' }]);
		assert.deepStrictEqual(p.line('--- FAIL: ./a_filetest.gno (elapsed: 0.00s, gas: 1)'), []);
		assert.deepStrictEqual(p.done(), [{ Action: 'fail', Test: 'a_filetest.gno', Elapsed: 0 }]);
	});
});
