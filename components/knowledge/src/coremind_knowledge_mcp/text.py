"""识别中文及字母数字知识行。"""

import re
import unicodedata


def terms(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    for token in re.findall(r"[\u3400-\u9fff]+|[a-z0-9]+", normalized):
        if len(token) > 1 and "\u3400" <= token[0] <= "\u9fff":
            yield from (token[i:i + 2] for i in range(len(token) - 1))
        else:
            yield token
