import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { __setObjectCacheBackendForTests } from "../../../src/object-cache/index.js";
import {
	getEmDashCollection,
	getEmDashEntry,
	getEmDashReferences,
	type ReferencePages,
} from "../../../src/query.js";
import type { EmDashRequestContext } from "../../../src/request-context.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveCollection: (_name: string, filter: never) => loader.loadCollection!({ filter }),
		getLiveEntry: async (_name: string, filter: never) => {
			const entry = await loader.loadEntry!({ filter });
			return entry && !("error" in entry) ? { entry, cacheHint: {} } : { entry: undefined };
		},
	};
});

/** Records the SQL a render issues, so reference resolution's cost is pinned. */
class QueryRecorder implements KyselyPlugin {
	statements: string[] = [];

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		this.statements.push("executed");
		return Promise.resolve(args.result);
	}
}

describeEachDialect("collection reference queries", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createField("pages", { slug: "featured", label: "Featured", type: "boolean" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const relations = new RelationRepository(db);
		await relations.create({
			slug: "posts_related_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});
		// The inverse: a page lists the posts that point at it.
		await registry.createField("pages", {
			slug: "linking_posts",
			label: "Linking posts",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "child",
				targetCollection: "posts",
			},
		});

		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		__setObjectCacheBackendForTests(null);
		setI18nConfig(null);
	});

	async function createPage(
		title: string,
		options: { publish?: boolean; featured?: boolean } = {},
	) {
		const slug = title.toLowerCase().replaceAll(" ", "-");
		const result = await handleContentCreate(db, "pages", {
			data: { title, featured: options.featured ?? false },
			slug,
		});
		if (!result.success) throw new Error(`Page setup failed: ${result.error.message}`);
		if (options.publish !== false) {
			const published = await runtime.handleContentPublish("pages", result.data.item.id);
			if (!published.success) throw new Error("Page publish failed");
		}
		return result.data.item;
	}

	async function createPost(title: string, pageIds: string[]) {
		const created = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: { related_pages: pageIds },
		});
		if (!created.success || !created.data) throw new Error("Post setup failed");
		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		if (!published.success) throw new Error("Post publish failed");
		return created.data.item;
	}

	function render<R>(fn: () => R, context: Partial<EmDashRequestContext> = {}) {
		return runWithContext({ editMode: false, db, ...context }, fn);
	}

	function plain(references: ReferencePages | undefined) {
		return Object.fromEntries(
			Object.entries(references ?? {}).map(([field, page]) => [
				field,
				{
					ids: page.entries.map((entry) => entry.id),
					data: page.entries.map((entry) => entry.data),
					nextCursor: page.nextCursor,
				},
			]),
		);
	}

	it("matches single-entry forward and reverse pages and continues their cursors", async () => {
		const pages = [await createPage("One"), await createPage("Two"), await createPage("Three")];
		await createPost(
			"Alpha",
			pages.map((page) => page.id),
		);
		await createPost("Beta", pages.map((page) => page.id).toReversed());
		for (const [collection, field] of [
			["posts", "related_pages"],
			["pages", "linking_posts"],
		] as const) {
			const references = { [field]: { limit: 1 } };
			const list = await render(() => getEmDashCollection(collection, { references }));
			expect(list.error).toBeUndefined();
			for (const entry of list.entries) {
				const single = await render(() => getEmDashEntry(collection, entry.id, { references }));
				expect(plain(entry.references)).toEqual(plain(single.entry?.references));
				expect(entry.references?.[field]?.nextCursor).toBeTruthy();
				const rest = await render(() =>
					getEmDashReferences(collection, entry.id, field, {
						limit: 1,
						cursor: entry.references?.[field]?.nextCursor,
					}),
				);
				expect(rest.error).toBeUndefined();
				expect(rest.entries).toHaveLength(1);
				expect(rest.entries[0]?.id).not.toBe(entry.references?.[field]?.entries[0]?.id);
			}
		}
	});

	it("omits invalid and undefined fields, preserves empty pages, and adds nothing without a selection", async () => {
		await createPost("Empty", []);
		const list = await render(() =>
			getEmDashCollection("posts", {
				references: { related_pages: true, title: true, unknown: true, omitted: undefined },
			}),
		);
		expect(list.error).toBeUndefined();
		expect(plain(list.entries[0]?.references)).toEqual({
			related_pages: { ids: [], data: [], nextCursor: undefined },
		});
		const without = await render(() => getEmDashCollection("posts"));
		expect(without.entries[0]?.references).toBeUndefined();
	});

	it("isolates preview drafts per entry and preserves staged empty selections", async () => {
		const live = await createPage("Live");
		const draft = await createPage("Draft", { publish: false });
		const a = await createPost("Alpha", [live.id]);
		const b = await createPost("Beta", [live.id]);
		const c = await createPost("Gamma", [live.id]);
		expect(
			(
				await runtime.handleContentUpdate("posts", a.id, {
					references: { related_pages: [draft.id] },
				})
			).success,
		).toBe(true);
		expect(
			(await runtime.handleContentUpdate("posts", b.id, { references: { related_pages: [] } }))
				.success,
		).toBe(true);
		expect(
			(await runtime.handleContentUpdate("posts", c.id, { data: { title: "Changed" } })).success,
		).toBe(true);
		const references = { related_pages: true } as const;
		for (const context of [
			{},
			{ editMode: true },
			{ preview: { collection: "posts", id: a.id } },
		]) {
			const list = await render(
				() => getEmDashCollection("posts", { references, orderBy: { slug: "asc" } }),
				context,
			);
			expect(list.error).toBeUndefined();
			const ids = list.entries.map((entry) =>
				entry.references?.related_pages.entries.map((child) => child.id),
			);
			expect(ids).toEqual(
				context.editMode
					? [["draft"], [], ["live"]]
					: context.preview
						? [["draft"], ["live"], ["live"]]
						: [["live"], ["live"], ["live"]],
			);
			for (const entry of list.entries) {
				const single = await render(
					() => getEmDashEntry("posts", entry.id, { references }),
					context,
				);
				expect(plain(entry.references)).toEqual(plain(single.entry?.references));
			}
		}
	});

	it("continues staged listing cursors after publication and restarts live cursors in drafts", async () => {
		const pages = [await createPage("One"), await createPage("Two"), await createPage("Three")];
		const post = await createPost(
			"Alpha",
			pages.map((page) => page.id),
		);
		const selection = { related_pages: { limit: 1 } };
		const live = await render(() => getEmDashCollection("posts", { references: selection }));
		expect(
			(
				await runtime.handleContentUpdate("posts", post.id, {
					references: { related_pages: pages.map((page) => page.id) },
				})
			).success,
		).toBe(true);
		const draft = await render(() => getEmDashCollection("posts", { references: selection }), {
			editMode: true,
		});
		const stagedCursor = draft.entries[0]?.references?.related_pages.nextCursor;
		expect(stagedCursor).toBeTruthy();
		const restart = await render(
			() =>
				getEmDashReferences("posts", post.id, "related_pages", {
					limit: 1,
					cursor: live.entries[0]?.references?.related_pages.nextCursor,
				}),
			{ editMode: true },
		);
		expect(restart.entries.map((entry) => entry.id)).toEqual(["one"]);
		expect((await runtime.handleContentPublish("posts", post.id)).success).toBe(true);
		const continued = await render(() =>
			getEmDashReferences("posts", post.id, "related_pages", { limit: 1, cursor: stagedCursor }),
		);
		expect(continued.entries.map((entry) => entry.id)).toEqual(["two"]);
		const listing = await render(() =>
			getEmDashCollection("posts", {
				references: { related_pages: { limit: 1, cursor: stagedCursor } },
			}),
		);
		expect(listing.entries[0]?.references?.related_pages.entries.map((entry) => entry.id)).toEqual([
			"two",
		]);
	});

	it("falls back to the parent's locale chain and drops invisible targets after pagination", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"], fallback: { fr: "en" } });
		const page = await createPage("English");
		const translation = await handleContentCreate(db, "pages", {
			data: { title: "Deutsch" },
			slug: "deutsch",
			locale: "de",
			translationOf: page.id,
		});
		if (!translation.success) throw new Error("Translation failed");
		await runtime.handleContentPublish("pages", translation.data.item.id);
		const hidden = await createPage("Hidden", { publish: false });
		const post = await createPost("Alpha", [hidden.id, page.id]);
		const translated = await handleContentCreate(db, "posts", {
			data: { title: "Bonjour" },
			slug: "bonjour",
			locale: "fr",
			translationOf: post.id,
		});
		if (!translated.success) throw new Error("Translation failed");
		await runtime.handleContentPublish("posts", translated.data.item.id);
		const result = await render(() =>
			getEmDashCollection("posts", { locale: "fr", references: { related_pages: true } }),
		);
		expect(
			result.entries[0]?.references?.related_pages.entries.map((entry) => entry.data.title),
		).toEqual(["English"]);
		const short = await render(() =>
			getEmDashCollection("posts", { references: { related_pages: { limit: 1 } } }),
		);
		expect(short.entries[0]?.references?.related_pages.entries).toEqual([]);
		expect(short.entries[0]?.references?.related_pages.nextCursor).toBeTruthy();
	});

	it("keys both caches on selection and invalidates on target edits with target route hints", async () => {
		const store = new Map<string, string>();
		__setObjectCacheBackendForTests(
			{
				get: (key) => Promise.resolve(store.get(key) ?? null),
				set: (key, value) => {
					store.set(key, value);
					return Promise.resolve();
				},
				delete: (key) => {
					store.delete(key);
					return Promise.resolve();
				},
			},
			{ revalidate: 1000, defaultTtl: 3600 },
		);
		const first = await createPage("One");
		const second = await createPage("Two");
		await createPost("Alpha", [first.id, second.id]);
		await render(async () => {
			await getEmDashCollection("posts");
			const narrow = await getEmDashCollection("posts", {
				references: { related_pages: { limit: 1 } },
			});
			expect(narrow.entries[0]?.references?.related_pages.entries).toHaveLength(1);
			const wide = await getEmDashCollection("posts", { references: { related_pages: true } });
			expect(wide.entries[0]?.references?.related_pages.entries).toHaveLength(2);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const warm = await render(() =>
			getEmDashCollection("posts", { references: { related_pages: true } }),
		);
		expect(warm.entries[0]?.references?.related_pages.entries).toHaveLength(2);
		expect(warm.cacheHint.tags).toEqual(expect.arrayContaining([first.id, second.id]));
		expect(
			(await runtime.handleContentUpdate("pages", first.id, { data: { title: "Renamed" } }))
				.success,
		).toBe(true);
		expect((await runtime.handleContentPublish("pages", first.id)).success).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const after = await render(() =>
			getEmDashCollection("posts", { references: { related_pages: true } }),
		);
		expect(after.entries[0]?.references?.related_pages.entries[0]?.data.title).toBe("Renamed");
		const row = await new ContentRepository(db).findById("pages", first.id);
		expect(after.cacheHint.lastModified!.getTime()).toBeGreaterThanOrEqual(
			new Date(row!.updatedAt!).getTime(),
		);
	});

	it.each([1, 49, 50, 51, 120])("batches %i parents and deduplicates targets", async (count) => {
		const page = await createPage("Shared");
		for (let index = 0; index < count; index++) await createPost(`Post ${index}`, [page.id]);
		const recorder = new QueryRecorder();
		const context = { db: db.withPlugin(recorder) };
		const without = await render(() => getEmDashCollection("posts"), context);
		expect(without.error).toBeUndefined();
		const base = recorder.statements.length;
		recorder.statements = [];
		const list = await render(
			() => getEmDashCollection("posts", { references: { related_pages: true } }),
			context,
		);
		expect(list.error).toBeUndefined();
		expect(list.entries).toHaveLength(count);
		const batched = recorder.statements.length;
		expect(batched - base).toBe(2 + Math.ceil(count / 50));
		recorder.statements = [];
		await render(async () => {
			for (const entry of without.entries) {
				const result = await getEmDashEntry("posts", entry.id, {
					references: { related_pages: true },
				});
				expect(result.error).toBeUndefined();
			}
		}, context);
		const perRow = recorder.statements.length;
		console.log(JSON.stringify({ parents: count, without: base, batched, perRow }));
		recorder.statements = [];
		await render(() => getEmDashCollection("posts"), context);
		expect(recorder.statements.length).toBe(base);
	});
});
