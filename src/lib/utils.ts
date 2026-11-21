/**
 * Sanitizes untrusted data before writing it to the adapter log.
 *
 * Escapes control characters that could otherwise inject or manipulate
 * log entries. Limits the output length to prevent excessive log data.
 *
 * Based on:
 * - OWASP Logging Cheat Sheet:
 *   https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
 * - CWE-117:
 *   https://cwe.mitre.org/data/definitions/117.html
 *
 * @param value - Untrusted input to sanitize
 * @param maxLength - Maximum output length (default: 500)
 * @returns Sanitized, length-limited string
 */
export function sanitizeLogMessage(value: string, maxLength = 500): string {
	// eslint-disable-next-line no-control-regex -- Intentionally matches control characters to prevent CWE-117 log injection.
	const sanitized = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, char => {
		if (char === "\r") {
			return "\\r";
		}
		if (char === "\n") {
			return "\\n";
		}
		if (char === "\t") {
			return "\\t";
		}
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});

	const chars = Array.from(sanitized);
	return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : sanitized;
}
