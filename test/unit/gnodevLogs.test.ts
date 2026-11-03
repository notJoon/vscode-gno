import * as assert from 'assert';
import { gnowebAddress, parseGnodevLog } from '../../src/gnodev/logs';

// Lines of `gnodev -log-format json`, trimmed.
suite('gnodev logs', () => {
	test('grouped line', () => {
		const log = parseGnodevLog(
			'{"level":"info","ts":1793706385.03,"msg":"gnoweb started","GnoWeb":{"lisn":"http://127.0.0.1:8888"}}'
		);
		assert.deepStrictEqual(log, {
			level: 'info',
			msg: 'gnoweb started',
			group: 'GnoWeb',
			args: { lisn: 'http://127.0.0.1:8888' }
		});
		assert.strictEqual(gnowebAddress(log!), 'http://127.0.0.1:8888');
	});

	test('ungrouped line', () => {
		const log = parseGnodevLog('{"level":"info","ts":1793706385.03,"msg":"node is ready","took":0.75}');
		assert.deepStrictEqual(log, { level: 'info', msg: 'node is ready', args: { took: 0.75 } });
		assert.strictEqual(gnowebAddress(log!), undefined);
	});

	test('non JSON line', () => {
		assert.strictEqual(parseGnodevLog('panic: boom'), undefined);
		assert.strictEqual(parseGnodevLog('42'), undefined);
	});
});
