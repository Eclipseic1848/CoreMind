# Knowledge retrieval and citations

Use knowledge retrieval to answer “Which passage in which edition supports this claim?” The project supplies the original documents, their versions, validity dates and read scopes. Applications can show the matching excerpt and direct readers to the corresponding edition.

For example, the two fixture editions list different desks for item `ST-17`: 榛果台 in edition one and 榆木台 in edition two. A current answer needs the item row from edition two. A rule found only in an expired edition cannot support a current claim.

P1 is accepted. P2 adds incremental imports, version withdrawal and old-citation resolution: one document ID and version accepts only one content revision, repeated imports report no change, changed content requires a version bump, withdrawn versions disappear from search, and `resolve_citation` reports available, withdrawn or unknown. Start with the [user guide](GUIDE.en.md) and use the [development SOP](SOP.en.md) to evaluate results. The [example](../../../examples/modules/manage-knowledge/README.en.md) includes the reference material. The [module manifest](module.yaml) lists the implementation and tests.

[Clean consumer verification](CLEAN-CONSUMER.en.md) covers isolated npm and Python installation, rebuilding the index from source, and repeating the check with release candidates.
