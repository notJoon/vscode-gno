/**
 * A line of gnodev output in `-log-format json`.
 */
export interface GnodevLog {
	level: string;
	msg: string;
	/** Logger group, such as `GnoWeb` or `Node`, when the line has one. */
	group?: string;
	args: Record<string, unknown>;
}

/**
 * Parses a gnodev JSON log line. gnodev nests the fields of a grouped logger
 * under the group name (`{"msg":"gnoweb started","GnoWeb":{"lisn":"..."}}`),
 * while ungrouped fields stay at the top level (`{"msg":"node is ready","took":0.7}`).
 * Returns undefined for lines that are not JSON objects.
 */
export function parseGnodevLog(line: string): GnodevLog | undefined {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		return undefined;
	}
	const { level, msg, ts, ...rest } = obj as Record<string, unknown>;
	const log: GnodevLog = { level: String(level ?? 'info'), msg: String(msg ?? ''), args: rest };
	const keys = Object.keys(rest);
	const value = rest[keys[0]];
	if (keys.length === 1 && value && typeof value === 'object' && !Array.isArray(value)) {
		log.group = keys[0];
		log.args = value as Record<string, unknown>;
	}
	return log;
}

/**
 * Returns the gnoweb URL announced by a `gnoweb started` log, if this is one.
 */
export function gnowebAddress(log: GnodevLog): string | undefined {
	if (log.msg !== 'gnoweb started') {
		return undefined;
	}
	const lisn = log.args['lisn'];
	return typeof lisn === 'string' ? lisn : undefined;
}
