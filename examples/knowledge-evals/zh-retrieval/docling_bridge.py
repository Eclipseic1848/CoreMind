"""将本地的中文 PDF、DOCX 或 Markdown 转为带来源定位的 UTF-8 JSON。"""

import argparse
import json
import sys
from pathlib import Path

from docling.datamodel.accelerator_options import AcceleratorOptions
from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import DocItemLabel, TableItem, TextItem

# Docling 按格式延迟加载流水线；长驻宿主复用同一转换器可避免重复加载模型。
_converter = DocumentConverter(
    allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.MD],
    format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=PdfPipelineOptions(
            accelerator_options=AcceleratorOptions(device="cpu"),
            ocr_options=RapidOcrOptions(lang=["ch"]),
        )),
    },
)


def parse_document(path):
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"找不到本地文件：{path}")
    result = _converter.convert(path)
    if result.status != ConversionStatus.SUCCESS:
        raise ValueError(f"文档未完整解析：{result.status.value}")

    chunks = []
    heading = None
    for item, _ in result.document.iterate_items():
        if isinstance(item, TableItem):
            text = item.export_to_markdown(doc=result.document)
        elif isinstance(item, TextItem):
            text = item.text
        else:
            continue
        if not text.strip():
            continue
        if item.label in (DocItemLabel.TITLE, DocItemLabel.SECTION_HEADER):
            heading = text.strip()
        pages = sorted({p.page_no for p in item.prov})
        if pages and result.input.format == InputFormat.PDF:
            locator = "page:" + ",".join(map(str, pages))
        else:
            locator = f"section:{heading or item.self_ref}"
        chunks.append({"text": text.strip(), "locator": locator})
    if not chunks:
        raise ValueError("文档没有可定位的文本或表格")
    return chunks


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    sys.stdout.buffer.write((json.dumps(parse_document(args.file), ensure_ascii=False) + "\n").encode("utf-8"))
