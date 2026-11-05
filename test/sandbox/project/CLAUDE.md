# Shelf

A reading list, stored as a text file with one book per line: `Title | Author | Year`.

- `src/` holds plain functions, `api/` holds request handlers, and `web/` holds static pages.
- There are no dependencies. Code is ES modules that also run in a browser, so `src/` and `api/` use no Node-only APIs.
- Run the tests with `npm test`. Tests live in `tests/`.
- Pages are served from the project root, so the home page is `/web/`.
