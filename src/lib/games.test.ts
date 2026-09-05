import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getCatalogSummary,
    getGameById,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

async function seedFilterFixtures(db: Database): Promise<{
    strategyId: number;
    puzzleId: number;
    firstPublisherId: number;
    secondPublisherId: number;
}> {
    const [{ id: strategyId }, { id: puzzleId }] = await db
        .insert(categories)
        .values([
            { name: 'Strategy', description: 'strategy' },
            { name: 'Puzzle', description: 'puzzle' },
        ])
        .returning({ id: categories.id });
    const [{ id: firstPublisherId }, { id: secondPublisherId }] = await db
        .insert(publishers)
        .values([
            { name: 'Pub One', description: 'first publisher' },
            { name: 'Pub Two', description: 'second publisher' },
        ])
        .returning({ id: publishers.id });

    await db.insert(games).values([
        {
            title: 'Strategy Alpha',
            description: 'Strategy Alpha',
            starRating: 4.2,
            categoryId: strategyId,
            publisherId: firstPublisherId,
        },
        {
            title: 'Puzzle Beta',
            description: 'Puzzle Beta',
            starRating: 4.2,
            categoryId: puzzleId,
            publisherId: firstPublisherId,
        },
        {
            title: 'Strategy Gamma',
            description: 'Strategy Gamma',
            starRating: 4.2,
            categoryId: strategyId,
            publisherId: secondPublisherId,
        },
        {
            title: 'Puzzle Delta',
            description: 'Puzzle Delta',
            starRating: 4.2,
            categoryId: puzzleId,
            publisherId: secondPublisherId,
        },
    ]);

    return { strategyId, puzzleId, firstPublisherId, secondPublisherId };
}

async function seedSummaryGames(db: Database, starRatings: Array<number | null>): Promise<void> {
    const [{ id: categoryId }] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'strategy' })
        .returning({ id: categories.id });
    const [{ id: publisherId }] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'publisher' })
        .returning({ id: publishers.id });

    await db.insert(games).values(
        starRatings.map((starRating, index) => ({
            title: `Summary Game ${index + 1}`,
            description: 'Summary fixture',
            starRating,
            categoryId,
            publisherId,
        })),
    );
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });

    it('filters games by any selected category', async () => {
        const { strategyId, puzzleId } = await seedFilterFixtures(db);

        const filtered = await getAllGames(db, { categoryIds: [strategyId, puzzleId] });

        expect(filtered.map((game) => game.title)).toEqual([
            'Puzzle Beta',
            'Puzzle Delta',
            'Strategy Alpha',
            'Strategy Gamma',
        ]);
    });

    it('filters games by publisher', async () => {
        const { firstPublisherId } = await seedFilterFixtures(db);

        const filtered = await getAllGames(db, { publisherId: firstPublisherId });

        expect(filtered.map((game) => game.title)).toEqual(['Puzzle Beta', 'Strategy Alpha']);
    });

    it('combines category and publisher filters', async () => {
        const { strategyId, secondPublisherId } = await seedFilterFixtures(db);

        const filtered = await getAllGames(db, {
            categoryIds: [strategyId],
            publisherId: secondPublisherId,
        });

        expect(filtered.map((game) => game.title)).toEqual(['Strategy Gamma']);
    });

    it('returns no games when filters do not match', async () => {
        const { strategyId, firstPublisherId } = await seedFilterFixtures(db);

        const filtered = await getAllGames(db, {
            categoryIds: [strategyId],
            publisherId: firstPublisherId + 100,
        });

        expect(filtered).toEqual([]);
    });

    it('returns the total and average across rated games', async () => {
        await seedSummaryGames(db, [4.1, 5, null]);

        const summary = await getCatalogSummary(db);

        expect(summary.totalGames).toBe(3);
        expect(summary.averageStarRating).toBeCloseTo(4.55);
    });

    it('returns an empty summary when the catalog has no games', async () => {
        await expect(getCatalogSummary(db)).resolves.toEqual({
            totalGames: 0,
            averageStarRating: null,
        });
    });

    it('returns a null average when no games have ratings', async () => {
        await seedSummaryGames(db, [null, null]);

        await expect(getCatalogSummary(db)).resolves.toEqual({
            totalGames: 2,
            averageStarRating: null,
        });
    });
});
