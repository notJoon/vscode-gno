/**
 * An exported crossing function of a realm, `func F(cur realm, ...)`, which
 * `gnokey maketx call` can call.
 */
export interface CrossingFunc {
	name: string;
	/** Parameters after `cur realm`, such as `n int`. */
	params: { name: string; type: string }[];
	/** Offset of `func` in the source. */
	offset: number;
}

/**
 * Returns the exported crossing functions declared at the top level of `src`.
 */
export function crossingFuncs(src: string): CrossingFunc[] {
	const funcs: CrossingFunc[] = [];
	for (const m of src.matchAll(/^func ([A-Z]\w*)\(\s*\w+\s+realm\s*(?:,([^)]*))?\)/gm)) {
		funcs.push({ name: m[1], params: parseParams(m[2] ?? ''), offset: m.index! });
	}
	return funcs;
}

/** Parses Go parameters such as `a, b string, n int` into named types. */
function parseParams(list: string): { name: string; type: string }[] {
	const params: { name: string; type: string }[] = [];
	let pending: string[] = [];
	for (const part of list.split(',').map((p) => p.trim())) {
		if (!part) {
			continue;
		}
		const [name, ...type] = part.split(/\s+/);
		pending.push(name);
		if (type.length) {
			params.push(...pending.map((n) => ({ name: n, type: type.join(' ') })));
			pending = [];
		}
	}
	return params;
}

/**
 * Returns the cause of a gnokey failure from its stderr: the first message
 * trace of a transaction error, or else the first line that is not the
 * password prompt.
 */
export function gnokeyError(stderr: string): string | undefined {
	const trace = /^\s*\d+\s+\S+ - (.+)$/m.exec(stderr)?.[1];
	return trace ?? stderr.split('\n').find((l) => l.trim() && !l.startsWith('Enter password'));
}
