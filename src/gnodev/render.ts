/**
 * Returns the gnoweb URL path that renders `Render(renderPath)` of the realm
 * with module path `module`, such as `/r/demo/foo:bar` for `gno.land/r/demo/foo`
 * and `bar`, or undefined if the module is not a realm.
 */
export function renderUrlPath(module: string, renderPath: string): string | undefined {
	const realm = /^[^/]+(\/r\/[^\s]+)$/.exec(module)?.[1];
	if (!realm) {
		return undefined;
	}
	return renderPath ? `${realm}:${encodeURI(renderPath)}` : realm;
}
