# Document assistant

[简体中文](README.md)

Compare document versions, cite each change, and format the summary using the reader's confirmed preference. The application owner supplies source records, the reader's access scope, and a memory bank. An optional ontology checks whether a business action is eligible.

## Create a project

Use the CLI containing this template, matching Node and Python SDKs, and Node.js 22.19 or later. After the public release, install the following versions. During candidate qualification, install the matching tarballs and wheel.

```sh
npx coremind-cli@2.0.0 create archive-desk --template document-assistant --language typescript --provider deepseek
cd archive-desk
npm install --save-exact coremind-ai@2.0.0 coremind-cli@2.0.0
python -m pip install coremind-ai==2.0.0
```

## Connect the services

| Service | Default address | Host setup |
| --- | --- | --- |
| Knowledge | `http://127.0.0.1:8767/mcp` | Register document versions and reader scope. Supply `COREMIND_KNOWLEDGE_AUTHORIZATION`. [Start and import](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-knowledge/README.en.md) |
| Hindsight memory | `http://127.0.0.1:8769/mcp` | Bind the reader to the authorized bank. Supply `COREMIND_MEMORY_AUTHORIZATION`. The host confirms, corrects, and forgets preferences. [Start and confirm a preference](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-memory/README.en.md) |
| Optional ontology | `http://127.0.0.1:8879/mcp` | Prepare the model and constraints. Supply `COREMIND_ONTOLOGY_AUTHORIZATION` to inspect action preconditions. [Start and bind a model](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-ontology/GUIDE.en.md) |

For a first run, point the knowledge service’s `--manifest` at the [archive corpus](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-ontology/document-assistant-corpora/archive/manifest.json). It includes two manual revisions and a draft table. A second project can use the [blue corpus](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-ontology/document-assistant-corpora/blue/manifest.json). Give each service its own reader credential.

Set the model key and both read credentials in the process environment. Each service credential is the complete `Bearer <token>` value issued by the host. This example uses PowerShell 7. Linux hosts may inject the same environment variables through their deployment platform. Keep administrative tokens in the host service.

```powershell
$env:DEEPSEEK_API_KEY = Read-Host 'DeepSeek API key' -MaskInput
$env:COREMIND_KNOWLEDGE_AUTHORIZATION = Read-Host 'Full knowledge Bearer header' -MaskInput
$env:COREMIND_MEMORY_AUTHORIZATION = Read-Host 'Full memory Bearer header' -MaskInput
```

To inspect publication eligibility, set the ontology read credential and provide the object identifier (such as `urn:doc:draft`) and action name (such as `publish`). Run `node enable-ontology.mjs` to create `coremind-ontology.yaml` from your current configuration. The configurations are independent. Generation stops if the output already exists so you can keep local edits. Update the endpoints and allowed addresses in the configuration to match your deployment.

## Run the four entry points

Run from the generated project. Replace the example title with one in your collection. Each command runs the same task, so choose one. A successful write updates `summary.md` in this project.

```powershell
$config = 'coremind.yaml'
$prompt = 'Compare the two versions of 资料室手册. Cite the file, version and location of each change, apply my confirmed formatting preference, and save the summary to summary.md.'
npx coremind run $config --prompt $prompt --session comparison
node run.mts $config $prompt
python -X utf8 run.py $config $prompt
python -X utf8 run.py --async $config $prompt
```

The CLI prompts for write approval in an interactive terminal. The SDK examples approve only a write to this project's `summary.md`. The knowledge and memory services and the Skill supply evidence. Publication and memory administration remain host operations.

Have the host confirm a preference for tables. From a new session, summarize another document and check its citations and format. Correct the preference to lists and withdraw one version. From another session, check the list format and remaining citations. To compare two readers, use separate project directories, reader bindings, and authorized banks. To check the ontology, use `coremind-ontology.yaml` as `$config` and ask for the `publish` eligibility of `urn:doc:draft`. A draft should return an observable reason for denial. When evidence is missing, the summary should identify the gap. [Comparison Skill](skills/document-comparison/SKILL.md)
