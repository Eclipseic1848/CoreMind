# Quality and Safety

CoreMind treats quality as an execution constraint, not a final prompt. Reliable agents need bounded loops, visible state, explicit permissions, reproducible evaluation, and honest failure results.

## Development gate

Run these checks before opening a pull request:

```bash
npm run check
npm test
npm run build
npm run docs:build
```

Python changes also require the Python test suite, wheel build, metadata check, and installation in a clean virtual environment.

## Runtime quality loop

A robust run follows a small cycle:

1. Plan the next bounded action.
2. Check permissions and remaining budget.
3. Execute one tool or model step.
4. Record trace and checkpoint state.
5. Evaluate the result against declared gates.
6. Finish, retry, replan, or fail with an explicit reason.

Retries must have a limit and should address a specific recoverable condition. Repeating the same failed request without changed evidence is not recovery.

## Security boundaries

- Start in `ask` mode.
- Keep secrets in environment variables.
- Treat model output and external content as untrusted input.
- Restrict file and command tools to the intended workspace.
- Require explicit approval before sending business data to external services.
- Never claim platform isolation that has not been verified.

Linux can provide operating-system isolation for the built-in shell when its prerequisites are available. Windows currently does not provide an equivalent shell sandbox. Custom tools are responsible for their own isolation on every platform. See the repository security policy for the current boundary.

## Evaluation

Use deterministic tests for parsers, policies, state transitions, and protocol behavior. Use golden examples for cross-language parity. Live-provider tests are opt-in because they have cost, network, privacy, and availability implications.

Record the model, provider, framework version, platform, dataset, evaluator, and timestamp so a result can be reproduced. Never mix simulated success with live certification.
