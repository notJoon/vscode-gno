/**
 * An event of a test run, in the shape of a `go test -json` event.
 */
export interface GnoTestEvent {
	Action: 'run' | 'pass' | 'fail' | 'skip' | 'output';
	Test: string;
	Output?: string;
	Elapsed?: number;
}

const runRegex = /^=== RUN\s+(?<name>\S+)/;
const endRegex = /^--- (?<action>PASS|FAIL|SKIP): (?<name>\S+) \((?:elapsed: )?(?<elapsed>[\d.]+)s/;
/**
 * Matches the summary of a package, which starts with its failures, like
 * `failed: "TestA"`, or `./z_filetest.gno failed` when only filetests failed.
 * It also matches the gas report that gno prints after each test.
 */
const summaryRegex = /^(?:ok|FAIL|\?)\s|^FAIL$|^FAIL: |^failed: |^\.\/\S+ failed(?:;|$)|^--- GAS: /;

/**
 * Names a filetest like its item: gno reports `./<file>`.
 */
function testName(name: string): string {
	return name.startsWith('./') ? name.substring(2) : name;
}

/**
 * Turns the output of `gno test -v`, line by line, into test events. Output
 * between the start and the end of a test belongs to it. gno prints the
 * details of a failed filetest after its FAIL line, so the fail event of a
 * test is held back until the next test starts or the summary is reached.
 */
export class GnoTestOutputParser {
	private current: string[] = [];
	private pendingFail?: GnoTestEvent;

	/**
	 * Parses one line of output, without its line ending.
	 */
	line(line: string): GnoTestEvent[] {
		const events: GnoTestEvent[] = [];
		const run = line.match(runRegex);
		const end = line.match(endRegex);

		if (run?.groups || end?.groups || summaryRegex.test(line)) {
			events.push(...this.flush());
		}

		if (run?.groups) {
			const Test = testName(run.groups.name);
			this.current.push(Test);
			events.push({ Action: 'run', Test });
		} else if (end?.groups) {
			const Test = testName(end.groups.name);
			const Action = end.groups.action.toLowerCase() as 'pass' | 'fail' | 'skip';
			const event = { Action, Test, Elapsed: Number(end.groups.elapsed) };
			this.current = this.current.filter((x) => x !== Test);
			if (Action === 'fail') {
				this.pendingFail = event;
			} else {
				events.push(event);
			}
		} else if (summaryRegex.test(line)) {
			this.current = [];
		} else {
			const Test = this.pendingFail?.Test ?? this.current[this.current.length - 1];
			if (Test) {
				events.push({ Action: 'output', Test, Output: line + '\n' });
			}
		}
		return events;
	}

	/**
	 * Returns the events held back at the end of the output.
	 */
	done(): GnoTestEvent[] {
		return this.flush();
	}

	private flush(): GnoTestEvent[] {
		const fail = this.pendingFail;
		this.pendingFail = undefined;
		return fail ? [fail] : [];
	}
}
