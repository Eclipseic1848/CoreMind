# Long-term Memory and Reflection

Any application with a Streamable HTTP MCP client can use the memory gateway on its own. The host runs Hindsight OSS 1.2.3 and PostgreSQL. The application receives a reader token and calls `recall_memory(query)`. A new authorized session can reuse a confirmed preference and pick up a correction.

The host establishes project, subject, agent, and session branch scope. It controls confirmation, correction, forgetting, and which lessons become active. The model uses a read-only tool to retrieve currently visible memories. Session history, run records, and knowledge sources keep their own data contracts.

CoreMind 2.0.0 ships the gateway scripts and pinned dependencies in the [release source ZIP](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0). Extract the memory directory into a host-owned service directory. The CLI and SDKs are optional clients. A separately installable gateway package and its version upgrade procedure are planned.

The [integration guide](GUIDE.en.md) and [example](../../../examples/modules/manage-memory/README.en.md) explain access and the memory lifecycle. The [development SOP](SOP.en.md) defines the acceptance checks. The [module manifest](module.yaml) lists implementation and test paths.
