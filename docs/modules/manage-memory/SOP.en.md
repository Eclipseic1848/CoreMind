# Long-term memory development SOP

Prepare at least two projects, two subjects, two agents, and two session branches. Record the Hindsight and optional model versions, along with the evidence, storage, and access scope used for the check. Run the following cases with synthetic inputs.

| Case | Verify |
| --- | --- |
| M01 Event retry | Submit the same bank, document ID, expected revision, and content concurrently, then replay after restart. Verify that only one active memory exists and that different input for the same document operation revision is rejected. |
| M02 Scope | Try a new session for the same subject and repeat with another project, subject, agent, and a branch without a grant. The authorized new session can recall. Out-of-scope search and administration by ID fail. |
| M03 Candidate extraction | Use two runs with different outcomes and propose a candidate with evidence, applicable conditions, and a counterexample. Verify absence before approval, visibility after approval, and absence after withdrawal. Test both an empty bank and a bank that contains related material but lacks a fact the question needs. Verify that the service withholds a candidate in both cases. |
| M04 Correction | Change the table preference to a list preference. Check that a new session only recalls the new value, and that a stale revision cannot overwrite it. Inject a storage failure and verify that the call reports failure and the old content never appears as a new revision. |
| M05 Expiry and forgetting | Expire a memory under a test clock. After forgetting, inspect storage, indexes, and read paths. Restart, search again, and replay the original event. Check the deployed backup policy for deletion replay on restore. |
| M06 Entry point parity | Search through CLI + YAML, the TypeScript SDK, and the synchronous and asynchronous Python SDKs. Compare the same fact and revision under the same scope. Disconnect the service and check the error. The agent should avoid substituting historical information for a current memory. |

Run the checks in the [module manifest](module.yaml) and `npm run check:modules`. Record the result, entry point, and failure stage for each case. When using a deterministic candidate fixture, report lifecycle behavior and live model extraction quality separately.

## Verify standalone deployment and upgrades

1. Deploy the three gateway files from the 2.0.0 source ZIP. In a separate empty project, use only a reader token and a standard MCP client. `tools/list` must expose just `recall_memory`. Write a fact through the host and query it through MCP. Check bank, document ID, revision, text and source. `/health` checks only the gateway process.
2. Run M01–M06. A missing or invalid reader token returns HTTP 401. A valid administrator targeting an ungranted bank gets 403. Exercise the published CLI, TypeScript SDK, and synchronous and asynchronous Python SDKs. All four callers resolve installed dependencies from the clean consumer. Python uses its bundled Worker. The existing `acceptance.mjs` checks a repository build.
3. Record the gateway source release, Hindsight client/API versions, PostgreSQL version, bindings and receipt path. In 2.0.0 the receipt JSON has no independent format version and is owned by one gateway process. Before upgrading, stop writes and back up PostgreSQL and the latest receipts. In an isolated copy, test an active fact, a forgotten fact, replay of its deletion, a stale correction and recall after restart with the same reader. On rollback, restore the previous software and consistent state, retain the newest forgetting receipts and replay those deletions. An independently released gateway will need compatibility, receipt migration and rollback tests for its own versions.

## P2-B verification record

- Hindsight OSS 1.2.3 and PostgreSQL covered writes, restart, correction, expiry, deletion, scope isolation, and recall through the four entry points. All eight memory service unit tests passed.
- The same five synthetic questions were rerun with `deepseek-flash` after tightening the direct evidence requirement. All three questions with direct evidence produced candidates for review. Neither of the two questions without direct evidence produced a candidate.
- With Hindsight automatic observations enabled for a separate check, deleting the source removed derived observations and orphaned entities. A control record in the same bank remained available. Automatic observations remain off by default.
- After logical PostgreSQL restore, current forgetting receipts blocked the restored content. Replaying the deletion twice left zero target documents, memory units, and native recall hits. The control record remained available. Verify physical backups, point-in-time recovery, backup media cleanup, and production scale in the deployment environment.
