import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/handlers/content.js";
import { setReferenceSelection } from "../../src/api/handlers/relations.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import type { Database } from "../../src/database/types.js";
import { resolveReferencePagesBatch } from "../../src/references/resolve.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * A listing resolves the links of every parent on the page together. D1 refuses
 * a statement with more than 100 bound parameters, so a page of 130 parents only
 * works if the batched link query is chunked.
 */
const PARENTS = 130;

let db: Kysely<Database>;
const parents: { translationGroup: string }[] = [];
const targets: { translationGroup: string }[] = [];

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "list_pages", label: "Pages" });
	await registry.createField("list_pages", { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({ slug: "list_posts", label: "Posts" });
	await registry.createField("list_posts", { slug: "title", label: "Title", type: "string" });
	const relation = await new RelationRepository(db).create({
		slug: "list_related_pages",
		parentCollection: "list_posts",
		childCollection: "list_pages",
		parentLabel: "Post",
		childLabel: "Related page",
	});
	await registry.createField("list_posts", {
		slug: "related_pages",
		label: "Related pages",
		type: "reference",
		validation: {
			relation: relation.slug,
			relationSide: "parent",
			targetCollection: "list_pages",
			multiple: true,
		},
	});

	for (let index = 0; index < 3; index++) {
		const page = await handleContentCreate(db, "list_pages", {
			data: { title: `Page ${index}` },
			status: "published",
		});
		if (!page.success) throw new Error("Page fixture setup failed");
		targets.push(page.data.item);
	}
	for (let index = 0; index < PARENTS; index++) {
		const post = await handleContentCreate(db, "list_posts", {
			data: { title: `Post ${index}` },
			status: "published",
		});
		if (!post.success) throw new Error("Post fixture setup failed");
		// Two links each, in an order that differs between parents.
		const first = targets[index % 3]!;
		const second = targets[(index + 1) % 3]!;
		const linked = await setReferenceSelection(
			db,
			"list_posts",
			post.data.item.id,
			"related_pages",
			[first.id, second.id],
		);
		if (!linked.success) throw new Error("Link fixture setup failed");
		parents.push(post.data.item);
	}
});

afterAll(async () => {
	await db.destroy();
});

function resolve(group: string[], limit?: number) {
	return runWithContext({ db, editMode: false }, () =>
		resolveReferencePagesBatch(
			"list_posts",
			{ related_pages: limit ? { limit } : true },
			group.map((entryGroup) => ({ entryGroup, locale: null, serveDrafts: false })),
		),
	);
}

const titles = (page: { entries: { data: Record<string, unknown> }[] } | undefined) =>
	page?.entries.map((entry) => entry.data.title);

it("resolves a page of more than 100 parents on D1, each in its own link order", async () => {
	const groups = parents.map((parent) => parent.translationGroup);
	const pages = await resolve(groups);
	expect(pages).toHaveLength(PARENTS);
	for (const [index, page] of pages.entries()) {
		expect(titles(page.related_pages)).toEqual([`Page ${index % 3}`, `Page ${(index + 1) % 3}`]);
	}
});

it("matches resolving each parent alone, including the per-parent limit and cursor", async () => {
	const groups = parents.map((parent) => parent.translationGroup);
	const batched = await resolve(groups, 1);
	for (const index of [0, 49, 50, 51, 99, 100, 129]) {
		const [alone] = await resolve([groups[index]!], 1);
		expect(titles(batched[index]!.related_pages)).toEqual(titles(alone!.related_pages));
		expect(batched[index]!.related_pages?.nextCursor).toBeDefined();
		expect(batched[index]!.related_pages?.nextCursor).toBe(alone!.related_pages?.nextCursor);
	}
});
