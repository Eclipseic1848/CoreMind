# Long-term Memory and Reflection

Long-term memory lets a project reuse confirmed preferences, facts, and lessons in a new session. A document assistant can recall a user's preference for summaries as tables when the host has granted that access. After a correction to lists, a new session should recall only the current revision.

P2-B integrates Hindsight OSS 1.2.3. The host establishes project, subject, agent, and session branch scope. It controls confirmation, correction, forgetting, and which lessons become active. The model uses a read-only tool to retrieve currently visible memories. Session history, run records, and knowledge sources keep their own data contracts.

The [integration guide](GUIDE.en.md) and [example](../../../examples/modules/manage-memory/README.en.md) explain access and the memory lifecycle. The [development SOP](SOP.en.md) defines the acceptance checks. The [module manifest](module.yaml) lists implementation and test paths.
