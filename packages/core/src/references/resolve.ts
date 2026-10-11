/**
 * Resolve an entry's reference selections to loadable entries, for the public
 * query path.
 *
 * The cost is bounded and predictable: one link read per selected field, then
 * one entry read per *distinct* target collection — never one per link. A
 * caller that selects no fields issues nothing at all, which is what keeps
 * references off the logged-out hot path of every render that does not ask for
 * them.
 */

import { RelationRepository } from "../database/repositories/relation.js";
import { RevisionRepository } from "../database/repositories/revision.js";
import { getFallbackChain, isI18nEnabled } from "../i18n/config.js";
import { getDb, loadEntriesByGroups, type LoadedEntry } from "../loader.js";
import { getReferenceFieldMap } from "./field-map.js";
import {
	pageStagedGroups,
	readStagedReferences,
	REFERENCE_PAGE_LIMIT,
	REFERENCE_PAGE_MAX_LIMIT,
	type PageOfGroups,
	type StagedReferences,
} from "./staged.js";
import type { ReferenceQuery, ReferenceSelection } from "./types.js";

/** One reference field's resolved page, before the query layer wraps the entries. */
export interface ResolvedReferencePage {
	/** The collection the entries belong to — what the `edit` proxy is scoped to. */
	collection: string;
	entries: LoadedEntry[];
	nextCursor?: string;
}

export interface ResolveReferencesOptions {
	/** The collection the selecting entry belongs to. */
	collection: string;
	/** The selecting entry's own translation group. */
	entryGroup: string;
	/** The locale the parent resolved to, used to pick each target's variant. */
	locale: string | null;
	/** The selecting entry's draft revision, when it has one. */
	draftRevisionId?: string;
	/**
	 * Whether this render may see unpublished content. It decides both halves of
	 * draft visibility: whether a pending selection staged in the draft revision
	 * replaces the published one, and whether an unpublished target resolves at
	 * all.
	 */
	serveDrafts: boolean;
	/** The fields to resolve, by field slug. */
	selection: ReferenceSelection;
}

function pageOptions(query: ReferenceQuery): { limit: number; cursor?: string } {
	if (query === true) return { limit: REFERENCE_PAGE_LIMIT };
	const requested = query.limit ?? REFERENCE_PAGE_LIMIT;
	return {
		limit: Math.min(Math.max(requested, 1), REFERENCE_PAGE_MAX_LIMIT),
		cursor: query.cursor,
	};
}

function localeChainFor(locale: string | null): string[] {
	if (locale === null) return [];
	return isI18nEnabled() ? getFallbackChain(locale) : [locale];
}

export async function resolveReferencePages(
	options: ResolveReferencesOptions,
): Promise<Record<string, ResolvedReferencePage>> {
	const staged =
		options.serveDrafts && options.draftRevisionId
			? readStagedReferences(
					(await new RevisionRepository(await getDb()).findById(options.draftRevisionId))?.data,
				)
			: undefined;
	return (
		await resolveReferencePagesBatch(options.collection, options.selection, [
			{ ...options, staged },
		])
	)[0];
}

export interface ReferenceParent {
	entryGroup: string;
	locale: string | null;
	serveDrafts: boolean;
	staged?: StagedReferences;
}

export async function resolveReferencePagesBatch(
	collection: string,
	selection: ReferenceSelection,
	parents: ReferenceParent[],
): Promise<Record<string, ResolvedReferencePage>[]> {
	if (parents.length === 0) return [];
	const fieldMap = await getReferenceFieldMap(collection);
	const requested = Object.entries(selection).filter(
		(entry): entry is [string, ReferenceQuery] => entry[1] !== undefined && fieldMap.has(entry[0]),
	);
	const pages = parents.map(() => new Map<string, PageOfGroups>());
	if (requested.length === 0) return parents.map(() => ({}));
	const relations = new RelationRepository(await getDb());
	await Promise.all(
		requested.map(async ([slug, query]) => {
			const binding = fieldMap.get(slug)!;
			const options = pageOptions(query);
			const liveGroups: string[] = [];
			for (const [index, parent] of parents.entries()) {
				const staged = parent.serveDrafts ? parent.staged?.[slug] : undefined;
				if (staged) pages[index].set(slug, pageStagedGroups(staged, options));
				else liveGroups.push(parent.entryGroup);
			}
			const live = await relations.getReferencePagesById(
				binding.relationId,
				binding.side,
				liveGroups,
				options,
			);
			for (const [index, parent] of parents.entries()) {
				if (pages[index].has(slug)) continue;
				const links = live.get(parent.entryGroup)!;
				pages[index].set(slug, {
					groups: links.items.map((link) =>
						binding.side === "child" ? link.parentGroup : link.childGroup,
					),
					nextCursor: links.nextCursor,
				});
			}
		}),
	);

	const loads = new Map<
		string,
		{
			collection: string;
			localeChain: string[];
			publishedOnly: boolean;
			groups: Set<string>;
			entries: Map<string, LoadedEntry>;
		}
	>();
	const loadKey = (targetCollection: string, parent: ReferenceParent) =>
		JSON.stringify([targetCollection, localeChainFor(parent.locale), parent.serveDrafts]);
	for (const [index, parent] of parents.entries()) {
		for (const [slug, page] of pages[index]) {
			const targetCollection = fieldMap.get(slug)!.targetCollection;
			const key = loadKey(targetCollection, parent);
			let load = loads.get(key);
			if (!load) {
				load = {
					collection: targetCollection,
					localeChain: localeChainFor(parent.locale),
					publishedOnly: !parent.serveDrafts,
					groups: new Set(),
					entries: new Map(),
				};
				loads.set(key, load);
			}
			for (const group of page.groups) load.groups.add(group);
		}
	}
	await Promise.all(
		Array.from(loads.values(), async (load) => {
			const entries = await loadEntriesByGroups(load.collection, [...load.groups], load);
			for (const entry of entries) {
				const group = entry.data.translationGroup;
				if (typeof group === "string") load.entries.set(group, entry);
			}
		}),
	);
	return parents.map((parent, index) => {
		const resolved: Record<string, ResolvedReferencePage> = {};
		for (const [slug, page] of pages[index]) {
			const targetCollection = fieldMap.get(slug)!.targetCollection;
			const loaded = loads.get(loadKey(targetCollection, parent))!.entries;
			resolved[slug] = {
				collection: targetCollection,
				entries: page.groups.flatMap((group) => {
					const entry = loaded.get(group);
					return entry ? [entry] : [];
				}),
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			};
		}
		return resolved;
	});
}
