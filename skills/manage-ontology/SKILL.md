---
name: manage-ontology
description: Build and verify an optional CoreMind business ontology when a project needs a versioned RDF vocabulary, source mappings, SHACL Core validation or a governed business action.
---

# Develop a project ontology

1. Ask the domain owner for a question to answer, the source identifiers, and one valid and one invalid example. A project only needs an ontology binding when the task uses those semantics.
2. Follow the [integration guide](../../docs/modules/manage-ontology/GUIDE.en.md). Supply vocabulary, instances, shapes, versioned field mappings and action definitions. Preserve source records and resolve ambiguous identities explicitly.
3. Expose inspection and record validation as read operations. A write action requires an explicit host binding, a distinct credential, the CoreMind tool policy and a fresh check of its prerequisites.
4. Compare the actual receipt with the target, request identifier, previous state and expected outcome. An unconfirmed effect requires reconciliation before another write.
5. Use the [development procedure](../../docs/modules/manage-ontology/SOP.en.md) to verify both vocabularies, correct and invalid records, enabled and unbound operation, model failure and the four public entry points. Retain model and bundle digests with the observations.

中文接入和验收见[业务本体指南](../../docs/modules/manage-ontology/GUIDE.zh-CN.md)和[开发 SOP](../../docs/modules/manage-ontology/SOP.zh-CN.md)。
