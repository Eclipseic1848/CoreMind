# 失败案例与修复

1. 找不到 worker：先在仓库根目录运行 npm run build:python-worker.
2. 找不到 coremind：安装 wheel 或设置 PYTHONPATH=../../../python/src.
3. 路径穿越会被 Python 工具拒绝，这是安全预期.

修复后重新运行对应失败场景，并比较修复前后 Trace；不要只看最终回答。
