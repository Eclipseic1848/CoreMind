from __future__ import annotations

import json
import sys
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from coremind import AsyncCoreMindClient, CoreMindClient, CoreMindError


INTEGER_LIST = list[int]
EFFECT = {"operations": ["read"], "reversible": True}
CONFIG = {"schemaVersion": 2, "name": "tool-annotations", "agents": {"main": {}}}


class ToolAnnotationTest(unittest.TestCase):
    def assert_schema(self, function, expected, parameters=None):
        for client_type in (CoreMindClient, AsyncCoreMindClient):
            with self.subTest(client=client_type.__name__):
                client = client_type(CONFIG)
                self.assertIs(client.tool(effect=EFFECT, parameters=parameters)(function), function)
                sync = client.sync_client if isinstance(client, AsyncCoreMindClient) else client
                self.assertEqual(sync._tools[function.__name__][1]["parameters"], expected)

    def test_future_annotations_preserve_supported_parameter_constraints(self):
        def probe(amount: int, label: str, enabled: bool, ratio: float,
                  values: INTEGER_LIST, names: tuple[str, ...], flags: set[bool],
                  metadata: dict[str, int], untyped, optional: int | None = None):
            pass

        self.assert_schema(probe, {
            "type": "object",
            "properties": {
                "amount": {"type": "integer"}, "label": {"type": "string"},
                "enabled": {"type": "boolean"}, "ratio": {"type": "number"},
                "values": {"type": "array", "items": {"type": "integer"}},
                "names": {"type": "array", "items": {"type": "string"}},
                "flags": {"type": "array", "items": {"type": "boolean"}},
                "metadata": {"type": "object"}, "untyped": {},
                "optional": {"type": "integer"},
            },
            "additionalProperties": False,
            "required": ["amount", "label", "enabled", "ratio", "values", "names",
                         "flags", "metadata", "untyped"],
        })

    def test_string_and_eager_annotations_keep_the_same_schema(self):
        for annotation in (int, "int", "'int'"):
            def probe(amount, label="default"):
                pass
            probe.__annotations__ = {"amount": annotation, "label": str}
            expected = {
                "type": "object", "properties": {
                    "amount": {"type": "integer"}, "label": {"type": "string"}},
                "additionalProperties": False, "required": ["amount"],
            }
            self.assert_schema(probe, expected)
            self.assert_schema(probe, expected, parameters={})

    def test_unresolved_parameter_requires_explicit_parameters_without_registration(self):
        for annotation in ("MissingToolType", "list[MissingToolType]", "list["):
            for client_type in (CoreMindClient, AsyncCoreMindClient):
                with self.subTest(annotation=annotation, client=client_type.__name__):
                    def probe(amount):
                        pass
                    probe.__annotations__ = {"amount": annotation}
                    client = client_type(CONFIG)
                    with self.assertRaisesRegex(CoreMindError, "probe.*无法解析.*parameters"):
                        client.tool(effect=EFFECT)(probe)
                    sync = client.sync_client if isinstance(client, AsyncCoreMindClient) else client
                    self.assertEqual(sync._tools, {})

    def test_explicit_parameters_bypass_unresolved_annotations(self):
        def probe(amount: MissingToolType) -> MissingReturnType:
            return amount

        parameters = {"type": "object", "properties": {"amount": {"type": "integer"}}}
        for client_type in (CoreMindClient, AsyncCoreMindClient):
            with self.subTest(client=client_type.__name__):
                client = client_type(CONFIG)
                client.tool(effect=EFFECT, parameters=parameters)(probe)
                sync = client.sync_client if isinstance(client, AsyncCoreMindClient) else client
                self.assertEqual(sync._tools["probe"][1]["parameters"], parameters)

    def test_unresolved_return_annotation_does_not_affect_parameter_schema(self):
        def probe(amount: int) -> MissingReturnType:
            return amount

        original = dict(probe.__annotations__)
        self.assert_schema(probe, {
            "type": "object", "properties": {"amount": {"type": "integer"}},
            "additionalProperties": False, "required": ["amount"],
        })
        self.assertEqual(probe.__annotations__, original)

    @unittest.skipIf(sys.version_info < (3, 14), "Python 3.14 才默认使用原生延迟注解")
    def test_native_delayed_return_does_not_block_parameter_resolution(self):
        namespace = {}
        exec(compile("def probe(amount: int) -> MissingReturnType: pass", "<native-annotations>",
                     "exec", dont_inherit=True), namespace)
        self.assert_schema(namespace["probe"], {
            "type": "object", "properties": {"amount": {"type": "integer"}},
            "additionalProperties": False, "required": ["amount"],
        })


class ToolAnnotationWorkerTest(unittest.IsolatedAsyncioTestCase):
    async def test_worker_validates_before_sync_and_async_python_execution(self):
        requests = []
        arguments = {}

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                tool = next((message for message in body["messages"] if message["role"] == "tool"), None)
                delta = ({"role": "assistant", "content": tool["content"]} if tool else {
                    "role": "assistant", "tool_calls": [{"index": 0, "id": "annotation-call",
                    "type": "function", "function": {"name": "probe", "arguments": json.dumps(arguments)}}]})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for part, finish in ((delta, None), ({}, "stop" if tool else "tool_calls")):
                    chunk = {"id": "annotations", "choices": [{"index": 0, "delta": part, "finish_reason": finish}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")

            def log_message(self, _format, *_args):
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        valid = {"amount": 5, "label": "ready", "enabled": True, "values": [1, 2]}
        # 保留底层既有类型转换；不能转换成声明类型的参数必须在执行前被拒绝。
        cases = [(None, None, True), ("amount", "5", True), ("amount", "wrong", False),
                 ("label", {"text": "wrong"}, False), ("enabled", "wrong", False),
                 ("values", "1,2", False), ("values", ["wrong"], False)]
        try:
            for asynchronous in (False, True):
                for field, value, accepted in cases:
                    with self.subTest(asynchronous=asynchronous, field=field, value=value):
                        arguments = {**valid, **({field: value} if field else {})}
                        executed = []

                        def probe(amount: int, label: str, enabled: bool, values: list[int]):
                            executed.append({"amount": amount, "label": label, "enabled": enabled, "values": values})
                            return amount * 2

                        async def async_probe(amount: int, label: str, enabled: bool, values: list[int]):
                            return probe(amount, label, enabled, values)

                        config = {**CONFIG, "provider": {"id": "probe", "model": "probe-model",
                                  "baseUrl": f"http://127.0.0.1:{model.server_port}/v1"},
                                  "runtime": {"maxRetries": 0, "runTimeoutMs": 10000}}
                        with tempfile.TemporaryDirectory(prefix="coremind-tool-annotations-") as directory:
                            client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
                            client = client_type(config, config_dir=directory, cwd=directory,
                                                 approval_handler=lambda _request: "allow", request_timeout=20)
                            client.tool(name="probe", effect=EFFECT)(async_probe if asynchronous else probe)
                            try:
                                result = await client.run("检查参数") if asynchronous else client.run("检查参数")
                            finally:
                                if asynchronous:
                                    await client.close()
                                else:
                                    client.close()
                        self.assertEqual(result["outcome"]["status"], "succeeded", result["outcome"])
                        tool_results = [entry["event"] for entry in result["trace"]
                                        if entry["event"]["type"] == "tool_result" and entry["event"].get("tool") == "probe"]
                        self.assertEqual(len(tool_results), 1)
                        if not accepted:
                            self.assertEqual(executed, [], "错误类型不得进入 Python callable")
                            self.assertTrue(tool_results[0]["isError"])
                        else:
                            self.assertEqual(executed, [valid])
                            self.assertEqual(result["transcript"], "10")
                            self.assertFalse(tool_results[0].get("isError", False))
                        schema = next(item["function"]["parameters"] for item in requests[-2]["tools"]
                                      if item["function"]["name"] == "probe")
                        self.assertEqual(schema["properties"]["amount"], {"type": "integer"})
                        self.assertEqual(schema["properties"]["values"], {"type": "array", "items": {"type": "integer"}})
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
