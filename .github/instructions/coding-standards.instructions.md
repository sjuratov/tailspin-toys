---
description: 'Repository-wide comments, documentation, and TypeScript coding standards'
applyTo: '**/*.{ts,astro,css}'
---

# Repository Coding Standards

Use these standards together with the technology-specific instruction file for the
file being changed. Prefer clear code over comments, and keep documentation close
to the API it describes.

## Comments and documentation

- Comment **why** code exists: explain intent, constraints, trade-offs, or a
  non-obvious decision.
- Do not add comments that merely paraphrase the next line or describe obvious
  mechanics.
- Keep comments accurate. Update or remove stale comments in the same change as
  the related code.
- Keep comments concise and focused. Use documentation comments for public APIs
  and ordinary comments only when the reasoning cannot be expressed clearly in
  the code.

### Data-layer APIs

Every exported function in `db/**/*.ts` and `src/lib/*.ts` must have a TSDoc or
JSDoc comment that includes:

- A concise statement of the function's purpose.
- An `@param` entry for every parameter, including the injectable `db`
  parameter used by data-access helpers.
- An `@returns` entry describing the returned value or promise.

Document public types when their shape or invariants are not self-evident. Keep
pure transforms free of database-specific explanations; document the
deterministic or domain rule they implement instead.

```ts
/**
 * Returns all games in title order for static page generation.
 *
 * @param db - Injectable Drizzle database client used by the query.
 * @returns Games mapped to the application-facing model.
 */
export async function getAllGames(db: Database): Promise<Game[]> {
    // Query implementation.
}
```

### Astro component contracts

Each reusable `.astro` component must make its public contract explicit with a
documented `Props` interface. Document the interface and add property comments
for fields whose purpose, accepted values, or default is not obvious.

```astro
---
/** Public inputs accepted by the game card component. */
interface Props {
    /** Game data displayed by the card. */
    game: Game;
}
---
```

## TypeScript formatting and types

Use the existing project style consistently:

- Four spaces for indentation in TypeScript blocks.
- Single-quoted strings, semicolons, and trailing commas in multiline
  declarations and calls.
- Spaces inside object braces (`{ value }`) and no spaces inside array brackets.
- Use `import type` for imports that have no runtime values.
- Give exported functions and data-layer helpers explicit parameter and return
  types. Prefer narrow unions and named interfaces over untyped objects.

ESLint enforces the formatting rules that can be checked safely (`quotes`,
`semi`, `comma-dangle`, `object-curly-spacing`, `eol-last`) and explicit types
at TypeScript module boundaries. Run the `quality-checks` skill after
TypeScript or Astro changes.

## Keeping standards current

When changing an API or component, update its TSDoc, Props documentation, and
related instruction guidance in the same change if the contract or rationale
changes.
