/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAi from "@earendil-works/pi-ai";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import type { KeyId } from "@earendil-works/pi-tui";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @earendil-works/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

// ============================================================================
// Extension metadata cache for fast startup
// ============================================================================

interface CachedToolMeta {
	name: string;
	description: string;
	// Serialized JSON Schema for parameters
	parameters?: unknown;
	executionMode?: string;
}

interface CachedCommandMeta {
	name: string;
	description?: string;
}

interface CachedExtensionMeta {
	path: string;
	resolvedPath: string;
	/** SHA-256 hash of the entry file content */
	hash: string;
	tools: CachedToolMeta[];
	commands: CachedCommandMeta[];
	/** Event types this extension has handlers for */
	handlerEvents: string[];
}

interface MetadataCache {
	version: number;
	extensions: CachedExtensionMeta[];
}

const META_CACHE_VERSION = 1;

function getMetaCachePath(): string {
	return path.join(getAgentDir(), "cache", "ext-metadata.json");
}

function computeFileHash(filePath: string): string {
	const crypto = require("node:crypto") as typeof import("node:crypto");
	// Handle directory paths (some extensions are directories with index.ts)
	let targetPath = filePath;
	if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
		const indexTs = path.join(filePath, "index.ts");
		const indexJs = path.join(filePath, "index.js");
		if (fs.existsSync(indexTs)) targetPath = indexTs;
		else if (fs.existsSync(indexJs)) targetPath = indexJs;
		else return "";
	}
	const content = fs.readFileSync(targetPath);
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Save extension metadata to cache after loading.
 */
function saveExtensionMetadata(extensions: Extension[]): void {
	try {
		const cachePath = getMetaCachePath();
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });

		const cached: MetadataCache = {
			version: META_CACHE_VERSION,
			extensions: extensions.map((ext) => {
				const hash = computeFileHash(ext.resolvedPath);
				const tools: CachedToolMeta[] = [];
				for (const tool of ext.tools.values()) {
					tools.push({
						name: tool.definition.name,
						description: tool.definition.description,
						parameters: tool.definition.parameters,
						executionMode: tool.definition.executionMode,
					});
				}
				const commands: CachedCommandMeta[] = [];
				for (const cmd of ext.commands.values()) {
					commands.push({
						name: cmd.name,
						description: cmd.description,
					});
				}
				return {
					path: ext.path,
					resolvedPath: ext.resolvedPath,
					hash,
					tools,
					commands,
					handlerEvents: Array.from(ext.handlers.keys()),
				};
			}),
		};

		fs.writeFileSync(cachePath, JSON.stringify(cached));
	} catch {
		// Cache save failure is non-fatal
	}
}

/**
 * Load extension metadata from cache.
 * Returns null if cache is missing, outdated, or any extension has changed.
 */
function loadExtensionMetadata(paths: string[]): MetadataCache | null {
	try {
		const cachePath = getMetaCachePath();
		if (!fs.existsSync(cachePath)) return null;

		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as MetadataCache;
		if (raw.version !== META_CACHE_VERSION) return null;

		// Verify all paths are in cache and hashes match
		const cachedByPath = new Map(raw.extensions.map((e) => [e.resolvedPath, e]));
		for (const extPath of paths) {
			const resolved = resolvePath(extPath);
			let cached = cachedByPath.get(resolved);
			if (!cached) {
				// Try to find by path field as well
				const cachedByOrigPath = raw.extensions.find((e) => e.path === extPath);
				if (!cachedByOrigPath) return null;
				cached = cachedByOrigPath;
			}
			// Verify hash
			try {
				const currentHash = computeFileHash(resolved);
				if (currentHash !== cached.hash) return null;
			} catch {
				return null;
			}
		}

		return raw;
	} catch {
		return null;
	}
}

/**
 * Create a stub extension from cached metadata.
 * Registers tool/command metadata but no real handlers.
 */
function createStubExtension(meta: CachedExtensionMeta): Extension {
	const extension: Extension = {
		path: meta.path,
		resolvedPath: meta.resolvedPath,
		sourceInfo: createSyntheticSourceInfo(meta.path, { source: "local", baseDir: path.dirname(meta.resolvedPath) }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};

	for (const toolMeta of meta.tools) {
		const toolDef: ToolDefinition = {
			name: toolMeta.name,
			label: toolMeta.name,
			description: toolMeta.description,
			parameters: (toolMeta.parameters as ToolDefinition["parameters"]) ?? {},
			executionMode: toolMeta.executionMode as ToolDefinition["executionMode"],
			execute: async () => {
				throw new Error(`Extension not loaded yet. Tool "${toolMeta.name}" is waiting for lazy load.`);
			},
		};
		extension.tools.set(toolMeta.name, {
			definition: toolDef,
			sourceInfo: extension.sourceInfo,
		});
	}

	for (const cmdMeta of meta.commands) {
		extension.commands.set(cmdMeta.name, {
			name: cmdMeta.name,
			description: cmdMeta.description,
			sourceInfo: extension.sourceInfo,
			handler: async () => {
				throw new Error(`Extension not loaded yet. Command "${cmdMeta.name}" is waiting for lazy load.`);
			},
		});
	}

	return extension;
}

// Track background loading state
let backgroundLoadPromise: Promise<void> | null = null;
let stubExtensions: Extension[] | null = null;
let realExtensions: Extension[] | null = null;
const _backgroundLoadErrors: { errors: Array<{ path: string; error: string }> } = { errors: [] };

/** Get errors from background extension loading (if any). */
export function getBackgroundLoadErrors(): Array<{ path: string; error: string }> {
	return _backgroundLoadErrors.errors;
}

/**
 * Wait for real extensions to be loaded.
 * Called before tool/command execution.
 */
export async function waitForExtensionsLoaded(): Promise<Extension[]> {
	if (realExtensions) return realExtensions;
	if (backgroundLoadPromise) {
		await backgroundLoadPromise;
		return realExtensions!;
	}
	return [];
}

/**
 * Get current extensions (stubs or real).
 */
export function getCurrentExtensions(): Extension[] {
	return realExtensions ?? stubExtensions ?? [];
}

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	"@earendil-works/pi-ai": _bundledPiAi,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");

	_aliases = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai": piAiEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai": piAiEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

// Shared jiti instance with module cache enabled. All extensions reuse this,
// so shared dependencies (pi-ai, pi-tui, typebox, etc.) are compiled once.
let sharedJiti: ReturnType<typeof createJiti> | undefined;

/** Reset shared jiti cache. Called on /reload so modified extensions are re-imported. */
export function resetExtensionModuleCache(): void {
	sharedJiti = undefined;
	realExtensions = null;
	stubExtensions = null;
	backgroundLoadPromise = null;
	_backgroundLoadErrors.errors = [];
}

/**
 * Delete metadata cache file. Called on explicit /reload so modified extensions
 * are re-discovered. NOT called on initial session creation.
 */
export function deleteExtensionMetadataCache(): void {
	try {
		const cachePath = getMetaCachePath();
		if (fs.existsSync(cachePath)) {
			fs.unlinkSync(cachePath);
		}
	} catch {}
}

function getSharedJiti() {
	if (!sharedJiti) {
		const fsCacheDir = path.join(getAgentDir(), "cache", "jiti");
		sharedJiti = createJiti(import.meta.url, {
			moduleCache: true,
			fsCache: fsCacheDir,
			...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
		});
	}
	return sharedJiti;
}

async function loadExtensionModule(extensionPath: string) {
	const jiti = getSharedJiti();
	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extId: number,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
	const parts = resolvedPath.split(path.sep);
	const shortPath = parts.length > 2 ? parts.slice(-3).join("/") : parts.slice(-2).join("/");
	const labelBase = `ext#${extId}[${shortPath}]`;

	try {
		const t0 = Date.now();
		time(`${labelBase}.module.start`);
		const factory = await loadExtensionModule(resolvedPath);
		time(`${labelBase}.module.end`);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		time(`${labelBase}.factory.start`);
		await factory(api);
		time(`${labelBase}.factory.end`);
		const totalMs = Date.now() - t0;
		if (totalMs > 500) {
			console.error(
				`[SLOW EXTENSION] ${resolvedPath} took ${totalMs}ms (module: ~${totalMs - 10}ms, factory: ~10ms)`,
			);
		}

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const resolvedCwd = resolvePath(cwd);
	const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Uses metadata cache for fast startup: on cache hit, returns stub extensions
 * immediately and loads real extensions in the background.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	time("extensions.loadExtensions.start");

	// Try metadata cache for fast startup
	const metaCache = loadExtensionMetadata(paths);
	if (metaCache && metaCache.extensions.length === paths.length) {
		time("extensions.metadataCache.hit");
		const stubs = metaCache.extensions.map(createStubExtension);
		stubExtensions = stubs;

		// Start background loading of real extensions
		backgroundLoadPromise = (async () => {
			time("extensions.backgroundLoad.start");
			const results = await Promise.all(
				paths.map(async (extPath, idx) => {
					const result = await loadExtension(extPath, resolvedCwd, resolvedEventBus, runtime, idx + 1);
					return { ...result, path: extPath };
				}),
			);
			const loaded: Extension[] = [];
			const errors: Array<{ path: string; error: string }> = [];
			for (const { extension, error, path } of results) {
				if (error) {
					errors.push({ path, error });
					continue;
				}
				if (extension) loaded.push(extension);
			}
			realExtensions = loaded;
			_backgroundLoadErrors.errors = errors;
			saveExtensionMetadata(loaded);
			time("extensions.backgroundLoad.end");
		})();

		return {
			extensions: stubs,
			errors: [],
			runtime,
			backgroundLoadPromise,
		};
	}

	time("extensions.metadataCache.miss");

	// No cache - load normally
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	let extId = 0;

	const results = await Promise.all(
		paths.map(async (extPath) => {
			const id = ++extId;
			const result = await loadExtension(extPath, resolvedCwd, resolvedEventBus, runtime, id);
			return { ...result, path: extPath };
		}),
	);
	time("extensions.loadExtensions.end");
	for (const { extension, error, path } of results) {
		if (error) {
			errors.push({ path, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	// Save metadata for next startup
	saveExtensionMetadata(extensions);
	realExtensions = extensions;

	return {
		extensions,
		errors,
		runtime,
	};
}

interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	time("extensions.discoverAndLoad.start");
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}
	const result = await loadExtensions(allPaths, resolvedCwd, eventBus);
	time("extensions.discoverAndLoad.end");
	return result;
}
