# Changelog

## Unreleased

- Return a document-version-scoped `chunkId` for PDF and DOCX citation lookup. Report an ambiguous legacy location without supplying an excerpt. Existing catalogs can supply the IDs directly from stored chunk order.

## 2.1.0 - 2026-11-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## Knowledge component 0.1.0 (local wheel)

- Install the local retrieval and citation service from a wheel using the `coremind-knowledge-mcp` console. Use an explicit manifest, model, scope and catalog with a standard MCP client. The existing source entry points and catalog schema remain compatible.

## 2.0.0

- Add cited knowledge retrieval with document versions, locations and reader scopes. Return the original table header and its line with a Markdown data row in both search and citation lookup. Import and withdraw idempotently, rebuild from source, preserve the previous usable catalog on a failed rebuild, and enforce scope during citation lookup. Verify CLI, TypeScript and Python sync/async against the same service.
