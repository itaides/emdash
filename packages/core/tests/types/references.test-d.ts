import { describe, expectTypeOf, it } from "vitest";

import {
	getEmDashCollection,
	getEmDashEntry,
	type ReferencePage,
	type ReferencePages,
	type CollectionFilter,
} from "../../src/query.js";

interface Author {
	id: string;
	name: string;
}

interface Post {
	id: string;
	title: string;
}

// What `generateTypesFile` emits for a collection with two bound reference
// fields, one pointing at another collection and one at itself.
declare module "../../src/query.js" {
	interface EmDashCollections {
		posts: Post;
		authors: Author;
	}
	interface EmDashCollectionReferences {
		posts: { author: ReferencePage<Author>; related_posts: ReferencePage<Post> };
	}
}

describe("getEmDashEntry references", () => {
	it("resolves a selected field to the target collection's interface", async () => {
		const { entry } = await getEmDashEntry("posts", "slug", { references: { author: true } });
		expectTypeOf(entry!.references!.author.entries[0]!.data).toEqualTypeOf<Author>();
	});

	it("narrows to the fields the caller named", async () => {
		const { entry } = await getEmDashEntry("posts", "slug", { references: { author: true } });
		expectTypeOf(entry!.references!).toEqualTypeOf<{ author: ReferencePage<Author> }>();
	});

	it("rejects a field the collection does not have", async () => {
		await getEmDashEntry("posts", "slug", {
			// @ts-expect-error - `nope` is not a reference field on posts
			references: { nope: true },
		});
	});

	it("leaves an unregistered collection's pages un-narrowed", async () => {
		const { entry } = await getEmDashEntry("widgets", "slug", { references: { anything: true } });
		expectTypeOf(entry!.references!.anything).toEqualTypeOf<ReferencePage>();
	});

	it("keeps the data parameter second, for resolveEmDashPath's explicit call", async () => {
		const { entry } = await getEmDashEntry<string, Post>("posts", "slug");
		expectTypeOf(entry!.data).toEqualTypeOf<Post>();
	});
});

describe("getEmDashCollection references", () => {
	it("narrows both pagination forms", async () => {
		const cursor = await getEmDashCollection("posts", {
			limit: 5,
			cursor: "cursor",
			references: { author: true },
		});
		expectTypeOf(cursor.entries[0]!.references!).toEqualTypeOf<{ author: ReferencePage<Author> }>();
		const offset = await getEmDashCollection("posts", {
			limit: 5,
			offset: 10,
			references: { related_posts: true },
		});
		expectTypeOf(offset.entries[0]!.references!).toEqualTypeOf<{
			related_posts: ReferencePage<Post>;
		}>();
	});
	it("preserves calls without selections and explicit data generics", async () => {
		const inferred = await getEmDashCollection("posts");
		expectTypeOf(inferred.entries[0]!.references!).toEqualTypeOf<ReferencePages>();
		const explicit = await getEmDashCollection<string, Post>("posts", { offset: 0 });
		expectTypeOf(explicit.entries[0]!.data).toEqualTypeOf<Post>();
		expectTypeOf(explicit.entries[0]!.references!).toEqualTypeOf<ReferencePages>();
		const typed = await getEmDashCollection<"posts">("posts", { references: { author: true } });
		expectTypeOf(typed.entries[0]!.references!.author).toEqualTypeOf<ReferencePage<Author>>();
		const custom = await getEmDashCollection<string, Post>("posts", { references: { any: true } });
		expectTypeOf(custom.entries[0]!.data).toEqualTypeOf<Post>();
		const filter: CollectionFilter = { limit: 3 };
		await getEmDashCollection("posts", filter);
	});
	it("rejects unknown fields and mixed pagination", async () => {
		// @ts-expect-error - no such reference on posts
		await getEmDashCollection("posts", { references: { nope: true } });
		// @ts-expect-error - pagination modes remain mutually exclusive
		await getEmDashCollection("posts", { cursor: "c", offset: 1, references: { author: true } });
	});
	it("accepts unregistered collections", async () => {
		const result = await getEmDashCollection("widgets", { references: { anything: true } });
		expectTypeOf(result.entries[0]!.references!.anything).toEqualTypeOf<ReferencePage>();
	});
});
