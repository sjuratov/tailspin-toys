import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Game } from '../types/game';

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

type GameSelectionRow = {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
};

/** Optional predicates for narrowing the game listing. */
export interface GameFilters {
    /** Categories to include; matching any selected category is sufficient. */
    categoryIds?: number[];
    /** Publisher to include in the results. */
    publisherId?: number;
}

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function baseGamesQuery(db: Database) {
    return db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));
}

function getFilterCondition(filters: GameFilters): SQL | undefined {
    const conditions: SQL[] = [];

    if (filters.categoryIds && filters.categoryIds.length > 0) {
        conditions.push(inArray(games.categoryId, filters.categoryIds));
    }

    if (filters.publisherId !== undefined) {
        conditions.push(eq(games.publisherId, filters.publisherId));
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Returns games ordered by title, optionally filtered by category and publisher.
 *
 * @param db - Injectable Drizzle database client used by the query.
 * @param filters - Optional category and publisher predicates.
 * @returns Games matching the filters, mapped to the application-facing model.
 */
export async function getAllGames(db: Database, filters: GameFilters = {}): Promise<Game[]> {
    const condition = getFilterCondition(filters);
    const query = baseGamesQuery(db);
    const rows = await (condition ? query.where(condition) : query).orderBy(asc(games.title));
    return rows.map(mapGame);
}

/**
 * Returns all game IDs in title order for static route generation.
 *
 * @param db - Injectable Drizzle database client used by the query.
 * @returns Game IDs ordered by title.
 */
export async function getAllGameIds(db: Database): Promise<number[]> {
    const rows = await db.select({ id: games.id }).from(games).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/**
 * Returns a single game by ID, or null when it does not exist.
 *
 * @param db - Injectable Drizzle database client used by the query.
 * @param id - Game ID to look up.
 * @returns The matching game, or null when no game has that ID.
 */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const row = await baseGamesQuery(db).where(eq(games.id, id)).get();
    return row ? mapGame(row) : null;
}
