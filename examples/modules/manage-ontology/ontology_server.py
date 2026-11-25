"""保留源码示例的原入口。"""

import _ontology_source
from coremind_ontology.server import main, make_app


if __name__ == "__main__":
    from ontology_project import demo_transition

    main(demo_executor=demo_transition)
