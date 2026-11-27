# Optional ontology and business actions

A project can supply its own vocabulary for objects, properties and relationships, align source records, and explain when an action is available. For example, a document repository can link two catalogue identifiers to one document, check its reviewer and then decide whether publication is possible.

Run `python -m pip install coremind-ontology-mcp==0.1.1` in a dedicated service environment, supply an external model directory, and bind only the read tools in an empty project. The component has its own version and business assets stay with the project. The CoreMind 2.0.0 source entry point remains compatible. [Component package](../../../components/ontology/README.md)

| Capability map | Module behavior |
| --- | --- |
| 06.01 Objects and relationships | Load a Turtle vocabulary and instance data. Inspect types, properties and outgoing relationships. |
| 06.02 Business concept alignment | Apply versioned identity, field, unit and code mappings. Preserve source records and unresolved alternatives. |
| 06.03 Constraints and validation | Run SHACL Core validation with pySHACL and return the affected resource, property, rule and explanation. |
| 06.04 Business actions | The host binds a target class, source state, destination state and handler. Execution checks permission, current prerequisites and the business receipt. |

A component built from the current source lets an authorized host reconcile an uncertain write using its original request ID. Once the business system confirms the outcome, the component stores it for follow-up actions. [Action reconciliation](GUIDE.en.md#host-reconciliation-and-follow-up-actions)

Projects can run with the ontology unbound. The CLI, TypeScript SDK and synchronous and asynchronous Python SDK can use the same Streamable HTTP MCP service. See the [integration guide](GUIDE.en.md), [runnable example](../../../examples/modules/manage-ontology/README.en.md) and [acceptance procedure](SOP.en.md).
