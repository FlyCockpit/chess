// stdout is for results, stderr for everything else (progress, prompts,
// notices), so `cockpit-chess whoami --json | jq` always gets clean JSON.

export function printResult(value: unknown, json: boolean, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human()}\n`);
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}
