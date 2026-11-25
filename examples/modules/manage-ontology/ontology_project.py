"""保留源码示例的原入口。"""

import _ontology_source
from coremind_ontology.project import OntologyProject


def demo_transition(command: dict) -> dict:
    """合成业务处理器。实际项目应返回其事务存储记录的回执。"""
    return {
        "status": "completed",
        "requestId": command["requestId"],
        "resource": command["resource"],
        "previousState": command["previousState"],
        "state": command["expectedState"],
    }
