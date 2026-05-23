/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable or --startup flag.
 */

let enabled = process.env.PI_TIMING === "1";
const timings: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();

export function resetTimings(): void {
	enabled = process.env.PI_TIMING === "1";
	if (!enabled) return;
	timings.length = 0;
	lastTime = Date.now();
}

export function time(label: string): void {
	if (!enabled) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

export function printTimings(): void {
	if (!enabled || timings.length === 0) return;
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error("------------------------\n");
}
